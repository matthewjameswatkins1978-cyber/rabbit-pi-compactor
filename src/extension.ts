import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, DEFAULT_MANUAL_TRIGGER_PERCENT, DEFAULT_OUTPUT_RESERVE_TOKENS, crossedThreshold, resolvePolicy, validateConfig } from "./policy.js";
import type { RabbitConfig, RabbitMode } from "./policy.js";
import { RABBIT_COMPACTION_INSTRUCTIONS } from "./instructions.js";

export const STATE_ENTRY = "rabbit-pi-compactor-state-v1";
export const RECEIPT_ENTRY = "rabbit-pi-compactor-receipt-v1";
const STATUS_KEY = "rabbit-compactor";

interface PersistedState {
  readonly kind: "rabbit-state";
  readonly mode: RabbitMode;
  readonly config: RabbitConfig;
  readonly armed: boolean;
  readonly emergencyAttempted?: boolean;
  readonly emergencyRetryEligible?: boolean;
  readonly lastCompactionAt?: string;
  readonly lastEstimatedTokensAfter?: number | undefined;
  readonly lastError?: string | undefined;
}

type Usage = { readonly tokens: number; readonly contextWindow: number; readonly percent: number; readonly reserveTokens: number };

function outputReserveTokens(pi: ExtensionAPI, ctx: ExtensionContext): number {
  try {
    const settings = pi.getSettings() as { compaction?: { reserveTokens?: number; modelOverrides?: Record<string, { reserveTokens?: number }> } };
    const model = ctx.model;
    const override = model ? settings.compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens : undefined;
    const reserve = override ?? settings.compaction?.reserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
    return Number.isSafeInteger(reserve) && reserve >= 0 ? reserve : DEFAULT_OUTPUT_RESERVE_TOKENS;
  } catch {
    return DEFAULT_OUTPUT_RESERVE_TOKENS;
  }
}

function readUsage(ctx: ExtensionContext, reserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS): Usage | undefined {
  try {
    const usage = ctx.getContextUsage();
    if (
      !usage ||
      usage.tokens === null ||
      !Number.isFinite(usage.tokens) ||
      !Number.isSafeInteger(usage.contextWindow) ||
      usage.contextWindow <= 0
    ) {
      return undefined;
    }
    const policy = resolvePolicy(usage.contextWindow, DEFAULT_CONFIG, reserveTokens);
    if (!policy) return undefined;
    const percent = (usage.tokens / policy.effectiveBudget) * 100;
    if (!Number.isFinite(percent)) return undefined;
    return {
      tokens: Math.max(0, Math.ceil(usage.tokens)),
      contextWindow: usage.contextWindow,
      percent,
      reserveTokens,
    };
  } catch {
    return undefined;
  }
}

function validState(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PersistedState> & { enabled?: boolean };
  try {
    validateConfig(item.config ?? {});
  } catch {
    return false;
  }
  return item.kind === "rabbit-state" && (item.mode === "auto" || item.mode === "manual" || item.mode === "off" || typeof item.enabled === "boolean") && typeof item.armed === "boolean";
}

function restore(ctx: ExtensionContext): PersistedState {
  let saved: PersistedState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && validState(entry.data)) {
      const legacy = entry.data as PersistedState & { enabled?: boolean };
      const config = validateConfig(legacy.config);
      const mode = legacy.mode ?? (legacy.enabled === false ? "off" : config.thresholdOverride === null ? "auto" : "manual");
      saved = { ...legacy, mode, config };
    }
  }
  return saved ?? { kind: "rabbit-state", mode: "auto", config: DEFAULT_CONFIG, armed: true };
}

export function createRabbitExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let state: PersistedState = {
      kind: "rabbit-state",
      mode: "auto",
      config: DEFAULT_CONFIG,
      armed: true,
    };
    let active = false;
    let generation = 0;
    let sessionId: string | undefined;
    let context: ExtensionContext | undefined;
    let previousValidTokens: number | undefined;
    let needsPressureCheck = false;
    let latestUsage: Usage | undefined;
    let completedMethod = "unknown";
    let compactionInFlight = false;

    const current = (ctx: ExtensionContext): boolean => {
      try {
        return active && ctx.sessionManager.getSessionId() === sessionId;
      } catch {
        return false;
      }
    };
    const persist = () => pi.appendEntry(STATE_ENTRY, state);
    const publish = (ctx: ExtensionContext) => {
      const currentUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
      if (currentUsage) latestUsage = currentUsage;
      const usage = currentUsage ?? latestUsage;
      const policy = resolvePolicy(usage?.contextWindow, state.config, usage?.reserveTokens);
      let label = "🐇 waiting for context usage";
      if (state.mode === "off") label = "🐇 off";
      else if (compactionInFlight) label = "🐇 compacting…";
      else if (!currentUsage && state.lastError) label = "🐇 compact failed";
      else if (!currentUsage && state.lastCompactionAt) label = "🐇 compacted";
      else if (usage && policy) {
        label = `🐇 ${Math.floor(usage.percent)}% → ${policy.targetPercent.toFixed(0)}%`;
      } else if (state.lastCompactionAt) label = "🐇 compacted";
      try {
        ctx.ui.setStatus(STATUS_KEY, label);
      } catch {
        // Status may not be available in headless Pi modes.
      }
    };
    const update = (ctx: ExtensionContext) => {
      if (!current(ctx)) return;
      const usage = readUsage(ctx, outputReserveTokens(pi, ctx));
      if (!usage) {
        // Null tokens after compaction are unknown, never zero or a trigger.
        previousValidTokens = undefined;
        publish(ctx);
        return;
      }
      latestUsage = usage;
      const policy = resolvePolicy(usage.contextWindow, state.config, usage.reserveTokens);
      if (!policy) return;
      let previous = previousValidTokens;
      previousValidTokens = usage.tokens;
      const firstMeasurementForRoute = needsPressureCheck;
      needsPressureCheck = false;
      if (state.mode === "off" || compactionInFlight) {
        publish(ctx);
        return;
      }
      if (!state.armed) {
        const rearmTokens = policy.targetTokens - Math.ceil((policy.effectiveBudget * state.config.hysteresisPercent) / 100);
        if (usage.tokens <= rearmTokens) {
          state = { ...state, armed: true, emergencyAttempted: false, emergencyRetryEligible: false };
          persist();
        } else if (
          state.mode === "auto" &&
          state.emergencyRetryEligible &&
          !state.emergencyAttempted &&
          crossedThreshold(previous, usage.tokens, policy.emergencyTokens)
        ) {
          // Give one failed normal attempt a single emergency retry at the guard.
          state = { ...state, armed: true, emergencyAttempted: true };
          previous = policy.targetTokens;
          persist();
        } else {
          publish(ctx);
          return;
        }
      }
      const emergency = state.mode === "auto" && (crossedThreshold(previous, usage.tokens, policy.emergencyTokens) || (firstMeasurementForRoute && usage.tokens > policy.emergencyTokens));
      const alreadyOverTrigger = firstMeasurementForRoute && usage.tokens > policy.targetTokens;
      if (!crossedThreshold(previous, usage.tokens, policy.targetTokens) && !alreadyOverTrigger && !emergency) {
        publish(ctx);
        return;
      }
      if (typeof ctx.compact !== "function") {
        publish(ctx);
        return;
      }

      const operationGeneration = generation;
      const operationSessionId = sessionId;
      compactionInFlight = true;
      state = {
        ...state,
        armed: false,
        lastError: undefined,
        emergencyRetryEligible: state.mode === "auto" && !emergency,
      };
      persist();
      publish(ctx);
      try {
        ctx.compact({
          customInstructions: [
            RABBIT_COMPACTION_INSTRUCTIONS,
            state.config.customInstructions,
          ].filter(Boolean).join("\n\n"),
          onComplete: (result) => {
            if (!active || generation !== operationGeneration || sessionId !== operationSessionId) return;
            compactionInFlight = false;
            const timestamp = new Date().toISOString();
            const postCompactUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
            previousValidTokens = undefined;
            state = {
              ...state,
              armed: false,
              lastCompactionAt: timestamp,
              lastEstimatedTokensAfter: result.estimatedTokensAfter,
              lastError: undefined,
              emergencyRetryEligible: false,
            };
            pi.appendEntry(RECEIPT_ENTRY, {
              version: 1,
              trigger: state.mode,
              mode: state.mode,
              reason: emergency ? "emergency" : "pressure",
              method: completedMethod,
              compactionNumber: ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RECEIPT_ENTRY).length + 1,
              contextWindow: usage.contextWindow,
              effectiveBudget: policy.effectiveBudget,
              outputReserveTokens: policy.reserveTokens,
              thresholdPercent: policy.targetPercent,
              beforePercent: usage.percent,
              provider: ctx.model?.provider ?? null,
              model: ctx.model?.id ?? null,
              afterTokens: postCompactUsage?.tokens ?? null,
              afterPercent: postCompactUsage?.percent ?? null,
              beforeTokens: usage.tokens,
              ...(result.estimatedTokensAfter !== undefined
                ? { estimatedTokensAfter: result.estimatedTokensAfter }
                : {}),
              timestamp,
            });
            if (postCompactUsage) {
              latestUsage = postCompactUsage;
              const rearmTokens = policy.targetTokens - Math.ceil((policy.effectiveBudget * state.config.hysteresisPercent) / 100);
              if (postCompactUsage.tokens <= rearmTokens) {
                state = { ...state, armed: true };
                previousValidTokens = postCompactUsage.tokens;
              }
            }
            persist();
            publish(ctx);
            if (ctx.hasUI) {
              ctx.ui.notify(
                `🐇 Compacted at ${usage.percent.toFixed(1)}% → ${policy.targetPercent.toFixed(1)}%${result.estimatedTokensAfter !== undefined ? ` (Pi estimate after: ${result.estimatedTokensAfter.toLocaleString()})` : ""}.`,
                "info",
              );
            }
          },
          onError: (error) => {
            if (!active || generation !== operationGeneration || sessionId !== operationSessionId) return;
            compactionInFlight = false;
            state = { ...state, armed: false, lastError: error.message };
            persist();
            publish(ctx);
            if (ctx.hasUI) ctx.ui.notify(`🐇 Compaction failed: ${error.message}`, "warning");
          },
        });
      } catch (error) {
        compactionInFlight = false;
        state = { ...state, armed: false, lastError: error instanceof Error ? error.message : String(error) };
        persist();
        publish(ctx);
      }
    };
    const manualCompact = (ctx: ExtensionCommandContext) => {
      if (!ctx.isIdle() || compactionInFlight || typeof ctx.compact !== "function") {
        ctx.ui.notify("Rabbit cannot compact while Pi is busy or compaction is unavailable.", "warning");
        return;
      }
      compactionInFlight = true;
      state = { ...state, armed: false, emergencyRetryEligible: false };
      const beforeUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
      const manualPolicy = resolvePolicy(beforeUsage?.contextWindow, state.config, beforeUsage?.reserveTokens);
      const sequence = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RECEIPT_ENTRY).length + 1;
      persist();
      publish(ctx);
      const operationGeneration = generation;
      const operationSessionId = sessionId;
      try {
        ctx.compact({
        customInstructions: [RABBIT_COMPACTION_INSTRUCTIONS, state.config.customInstructions]
          .filter(Boolean).join("\n\n"),
        onComplete: (result) => {
          if (generation !== operationGeneration || sessionId !== operationSessionId) return;
          compactionInFlight = false;
          state = {
            ...state,
            armed: false,
            lastCompactionAt: new Date().toISOString(),
            lastEstimatedTokensAfter: result.estimatedTokensAfter,
            lastError: undefined,
            emergencyRetryEligible: false,
          };
          const postCompactUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
          previousValidTokens = undefined;
          if (postCompactUsage) {
            latestUsage = postCompactUsage;
            if (manualPolicy) {
              const rearmTokens = manualPolicy.targetTokens - Math.ceil((manualPolicy.effectiveBudget * state.config.hysteresisPercent) / 100);
              if (postCompactUsage.tokens <= rearmTokens) {
                state = { ...state, armed: true };
                previousValidTokens = postCompactUsage.tokens;
              }
            }
          }
          pi.appendEntry(RECEIPT_ENTRY, {
            version: 1,
            compactionNumber: sequence,
            trigger: "manual",
            mode: state.mode,
            reason: "manual",
            method: completedMethod,
            provider: ctx.model?.provider ?? null,
            model: ctx.model?.id ?? null,
            contextWindow: beforeUsage?.contextWindow ?? null,
            effectiveBudget: manualPolicy?.effectiveBudget ?? null,
            outputReserveTokens: manualPolicy?.reserveTokens ?? null,
            beforeTokens: beforeUsage?.tokens ?? null,
            beforePercent: beforeUsage?.percent ?? null,
            afterTokens: postCompactUsage?.tokens ?? null,
            afterPercent: postCompactUsage?.percent ?? null,
            estimatedTokensAfter: result.estimatedTokensAfter ?? null,
            thresholdPercent: manualPolicy?.targetPercent ?? null,
            timestamp: new Date().toISOString(),
          });
          persist();
          publish(ctx);
        },
        onError: (error) => {
          if (generation !== operationGeneration || sessionId !== operationSessionId) return;
          compactionInFlight = false;
          state = { ...state, armed: false, lastError: error.message };
          persist();
          publish(ctx);
        },
      });
      // Compact is fire-and-forget; synchronous failures still need visible status.
      } catch (error) {
        compactionInFlight = false;
        state = { ...state, armed: false, lastError: error instanceof Error ? error.message : String(error) };
        persist();
        publish(ctx);
      }
    };

    pi.on("session_start", (_event, ctx) => {
      generation += 1;
      active = true;
      context = ctx;
      sessionId = ctx.sessionManager.getSessionId();
      state = restore(ctx);
      compactionInFlight = false;
      needsPressureCheck = true;
      latestUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
      previousValidTokens = latestUsage?.tokens;
      publish(ctx);
    });
    pi.on("session_tree", (_event, ctx) => {
      generation += 1;
      compactionInFlight = false;
      context = ctx;
      sessionId = ctx.sessionManager.getSessionId();
      state = restore(ctx);
      needsPressureCheck = true;
      latestUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
      previousValidTokens = latestUsage?.tokens;
      publish(ctx);
    });
    pi.on("session_shutdown", () => {
      generation += 1;
      active = false;
      compactionInFlight = false;
      previousValidTokens = undefined;
      if (context) {
        try { context.ui.setStatus(STATUS_KEY, undefined); } catch { /* Pi is shutting down. */ }
      }
      context = undefined;
      sessionId = undefined;
    });
    pi.on("turn_end", (_event, ctx) => update(ctx));
    pi.on("model_select", (_event, ctx) => {
      latestUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
      previousValidTokens = latestUsage?.tokens;
      state = { ...state, armed: true };
      state = { ...state, emergencyAttempted: false, emergencyRetryEligible: false };
      needsPressureCheck = true;
      persist();
      publish(ctx);
    });
    pi.on("session_compact", (event, ctx) => {
      if (!current(ctx)) return;
      const details = event.compactionEntry?.details;
      completedMethod = !event.fromExtension
        ? "pi-local"
        : typeof details === "object" && details !== null &&
            "protocol" in details && "replacementHistory" in details
          ? "provider-native"
          : "extension";
      if (!compactionInFlight) {
        state = { ...state, armed: false, lastCompactionAt: new Date().toISOString() };
        persist();
      }
      previousValidTokens = undefined;
      latestUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
      publish(ctx);
    });
    pi.on("session_compact_failed", (event, ctx) => {
      if (!current(ctx) || !compactionInFlight) return;
      compactionInFlight = false;
      state = { ...state, armed: false, lastError: event.errorMessage ?? "Pi compaction failed." };
      persist();
      publish(ctx);
    });
    pi.registerCommand("rabbit", {
      description: "Inspect and configure Rabbit Pi Compactor",
      handler: async (args, ctx) => {
        context = ctx;
        const [requestedOperation, value] = args.trim().split(/\s+/, 2);
        const operation = requestedOperation || "status";
        if (operation === "status") {
          const currentUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
          if (currentUsage) latestUsage = currentUsage;
          const usage = currentUsage ?? latestUsage;
          const policy = resolvePolicy(usage?.contextWindow, state.config, usage?.reserveTokens);
          const lastReceipt = [...ctx.sessionManager.getBranch()].reverse().find((entry) =>
            entry.type === "custom" && entry.customType === RECEIPT_ENTRY,
          );
          ctx.ui.notify([
            "RABBIT PI COMPACTOR",
            `mode: ${state.mode}`,
            `model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}`,
            `context: ${currentUsage && policy ? `${currentUsage.tokens.toLocaleString()} / ${policy.effectiveBudget.toLocaleString()} effective (${currentUsage.percent.toFixed(1)}%); window ${currentUsage.contextWindow.toLocaleString()}, output reserve ${policy.reserveTokens.toLocaleString()}` : usage ? `unknown; last observed ${usage.percent.toFixed(1)}% effective` : "unknown"}`,
            `trigger: ${policy ? `${policy.targetPercent.toFixed(1)}% (${policy.band})` : "waiting for context usage"}`,
            `emergency guard: ${policy ? `${policy.emergencyPercent}%` : "unavailable"}`,
            `state: ${compactionInFlight ? "compacting" : state.armed ? "armed" : "hysteresis"}`,
            `compactions: ${ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RECEIPT_ENTRY).length}`,
            `method: ${lastReceipt?.type === "custom" ? (lastReceipt.data as { method?: string }).method ?? "unknown" : "unknown"}`,
            `last compact: ${state.lastCompactionAt ?? "never"}`,
            ...(state.lastEstimatedTokensAfter !== undefined ? [`Pi estimated after: ${state.lastEstimatedTokensAfter.toLocaleString()} tokens`] : []),
            ...(state.lastError ? [`last error: ${state.lastError}`] : []),
          ].join("\n"), "info");
          return;
        }
        if (operation === "on" || operation === "off") {
          state = { ...state, mode: operation === "off" ? "off" : state.config.thresholdOverride === null ? "auto" : "manual" };
          needsPressureCheck = operation === "on";
          persist();
          publish(ctx);
          ctx.ui.notify(`Rabbit ${operation}.`, "info");
          return;
        }
        if (operation === "compact") {
          manualCompact(ctx);
          return;
        }
        if (operation === "mode") {
          if (value !== "auto" && value !== "manual" && value !== "off") {
            ctx.ui.notify("Usage: /rabbit mode auto|manual|off", "warning");
            return;
          }
          state = {
            ...state,
            mode: value as RabbitMode,
            config: value === "auto"
              ? validateConfig({ ...state.config, thresholdOverride: null })
              : value === "manual" && state.config.thresholdOverride === null
                ? validateConfig({ ...state.config, thresholdOverride: DEFAULT_MANUAL_TRIGGER_PERCENT })
                : state.config,
          };
          needsPressureCheck = value !== "off";
          persist();
          publish(ctx);
          ctx.ui.notify(`Rabbit mode set to ${value}.`, "info");
          return;
        }
        if (operation === "threshold") {
          try {
            const thresholdOverride = value === "adaptive" ? null : Number(value);
            state = { ...state, mode: value === "adaptive" ? "auto" : "manual", config: validateConfig({ ...state.config, thresholdOverride }) };
            previousValidTokens = readUsage(ctx, outputReserveTokens(pi, ctx))?.tokens;
            needsPressureCheck = value !== "adaptive";
            persist();
            publish(ctx);
            ctx.ui.notify(
              value === "adaptive" ? "Rabbit is using the adaptive threshold." : `Rabbit threshold set to ${thresholdOverride}%.`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
          }
          return;
        }
        ctx.ui.notify("Usage: /rabbit status|mode auto|manual|off|on|off|compact|threshold <1-99|adaptive>", "warning");
      },
    });
  };
}
