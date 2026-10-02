import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, crossedThreshold, resolvePolicy, validateConfig } from "./policy.js";
import type { RabbitConfig } from "./policy.js";
import { RABBIT_COMPACTION_INSTRUCTIONS } from "./instructions.js";

export const STATE_ENTRY = "rabbit-pi-compactor-state-v1";
export const RECEIPT_ENTRY = "rabbit-pi-compactor-receipt-v1";
const STATUS_KEY = "rabbit-compactor";

interface PersistedState {
  readonly kind: "rabbit-state";
  readonly enabled: boolean;
  readonly config: RabbitConfig;
  readonly armed: boolean;
  readonly lastCompactionAt?: string;
  readonly lastEstimatedTokensAfter?: number | undefined;
  readonly lastError?: string | undefined;
}

type Usage = { readonly tokens: number; readonly contextWindow: number; readonly percent: number };

function readUsage(ctx: ExtensionContext): Usage | undefined {
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
    const percent = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
    if (!Number.isFinite(percent)) return undefined;
    return {
      tokens: Math.max(0, Math.ceil(usage.tokens)),
      contextWindow: usage.contextWindow,
      percent,
    };
  } catch {
    return undefined;
  }
}

function validState(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PersistedState>;
  try {
    validateConfig(item.config ?? {});
  } catch {
    return false;
  }
  return item.kind === "rabbit-state" && typeof item.enabled === "boolean" && typeof item.armed === "boolean";
}

function restore(ctx: ExtensionContext): PersistedState {
  let saved: PersistedState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && validState(entry.data)) {
      saved = { ...entry.data, config: validateConfig(entry.data.config) };
    }
  }
  return saved ?? { kind: "rabbit-state", enabled: true, config: DEFAULT_CONFIG, armed: true };
}

export function createRabbitExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let state: PersistedState = {
      kind: "rabbit-state",
      enabled: true,
      config: DEFAULT_CONFIG,
      armed: true,
    };
    let active = false;
    let generation = 0;
    let sessionId: string | undefined;
    let context: ExtensionContext | undefined;
    let previousValidPercent: number | undefined;
    let latestUsage: Usage | undefined;
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
      const currentUsage = readUsage(ctx);
      if (currentUsage) latestUsage = currentUsage;
      const usage = currentUsage ?? latestUsage;
      const policy = resolvePolicy(usage?.contextWindow, state.config);
      let label = "🐇 waiting for context usage";
      if (!state.enabled) label = "🐇 off";
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
      const usage = readUsage(ctx);
      if (!usage) {
        // Null tokens after compaction are unknown, never zero or a trigger.
        previousValidPercent = undefined;
        publish(ctx);
        return;
      }
      latestUsage = usage;
      const policy = resolvePolicy(usage.contextWindow, state.config);
      if (!policy) return;
      const previous = previousValidPercent;
      previousValidPercent = usage.percent;
      if (!state.enabled || compactionInFlight) {
        publish(ctx);
        return;
      }
      if (!state.armed) {
        if (usage.percent <= policy.targetPercent - state.config.hysteresisPercent) {
          state = { ...state, armed: true };
          persist();
        }
        publish(ctx);
        return;
      }
      if (!crossedThreshold(previous, usage.percent, policy.targetPercent)) {
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
      state = { ...state, armed: false, lastError: undefined };
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
            state = {
              ...state,
              armed: false,
              lastCompactionAt: timestamp,
              lastEstimatedTokensAfter: result.estimatedTokensAfter,
              lastError: undefined,
            };
            pi.appendEntry(RECEIPT_ENTRY, {
              version: 1,
              trigger: "adaptive-threshold",
              contextWindow: usage.contextWindow,
              thresholdPercent: policy.targetPercent,
              tokensBefore: usage.tokens,
              ...(result.estimatedTokensAfter !== undefined
                ? { estimatedTokensAfter: result.estimatedTokensAfter }
                : {}),
              timestamp,
            });
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
      state = { ...state, armed: false };
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
          };
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
      latestUsage = readUsage(ctx);
      previousValidPercent = latestUsage?.percent;
      publish(ctx);
    });
    pi.on("session_tree", (_event, ctx) => {
      generation += 1;
      compactionInFlight = false;
      context = ctx;
      sessionId = ctx.sessionManager.getSessionId();
      state = restore(ctx);
      latestUsage = readUsage(ctx);
      previousValidPercent = latestUsage?.percent;
      publish(ctx);
    });
    pi.on("session_shutdown", () => {
      generation += 1;
      active = false;
      compactionInFlight = false;
      previousValidPercent = undefined;
      if (context) {
        try { context.ui.setStatus(STATUS_KEY, undefined); } catch { /* Pi is shutting down. */ }
      }
      context = undefined;
      sessionId = undefined;
    });
    pi.on("turn_end", (_event, ctx) => update(ctx));
    pi.on("model_select", (_event, ctx) => {
      latestUsage = readUsage(ctx);
      previousValidPercent = latestUsage?.percent;
      state = { ...state, armed: true };
      persist();
      publish(ctx);
    });
    pi.on("session_compact", (_event, ctx) => {
      if (!current(ctx)) return;
      if (!compactionInFlight) {
        state = { ...state, armed: false, lastCompactionAt: new Date().toISOString() };
        persist();
      }
      previousValidPercent = undefined;
      latestUsage = readUsage(ctx);
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
          const currentUsage = readUsage(ctx);
          if (currentUsage) latestUsage = currentUsage;
          const usage = currentUsage ?? latestUsage;
          const policy = resolvePolicy(usage?.contextWindow, state.config);
          ctx.ui.notify([
            "RABBIT PI COMPACTOR",
            `enabled: ${state.enabled ? "yes" : "no"}`,
            `context: ${currentUsage ? `${currentUsage.tokens.toLocaleString()} / ${currentUsage.contextWindow.toLocaleString()} (${currentUsage.percent.toFixed(1)}%)` : usage ? `unknown; last observed ${usage.percent.toFixed(1)}%` : "unknown"}`,
            `threshold: ${policy ? `${policy.targetPercent.toFixed(1)}% (${policy.band})` : "waiting for context usage"}`,
            `state: ${compactionInFlight ? "compacting" : state.armed ? "armed" : "hysteresis"}`,
            `last compact: ${state.lastCompactionAt ?? "never"}`,
            ...(state.lastEstimatedTokensAfter !== undefined ? [`Pi estimated after: ${state.lastEstimatedTokensAfter.toLocaleString()} tokens`] : []),
            ...(state.lastError ? [`last error: ${state.lastError}`] : []),
          ].join("\n"), "info");
          return;
        }
        if (operation === "on" || operation === "off") {
          state = { ...state, enabled: operation === "on" };
          persist();
          publish(ctx);
          ctx.ui.notify(`Rabbit ${operation}.`, "info");
          return;
        }
        if (operation === "compact") {
          manualCompact(ctx);
          return;
        }
        if (operation === "threshold") {
          try {
            const thresholdOverride = value === "adaptive" ? null : Number(value);
            state = { ...state, config: validateConfig({ ...state.config, thresholdOverride }) };
            previousValidPercent = readUsage(ctx)?.percent;
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
        ctx.ui.notify("Usage: /rabbit status|on|off|compact|threshold <1-99|adaptive>", "warning");
      },
    });
  };
}
