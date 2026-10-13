import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, DEFAULT_MANUAL_TRIGGER_PERCENT, DEFAULT_OUTPUT_RESERVE_TOKENS, crossedThreshold, resolvePolicy, validateConfig } from "./policy.js";
import type { RabbitConfig, RabbitMode } from "./policy.js";
import { Type } from "typebox";
import { RABBIT_COMPACTION_INSTRUCTIONS } from "./instructions.js";

import { GARDEN_RECEIPT_ENTRY, MAX_GARDEN_STATE_CHARS, MAX_GARDEN_UNITS, restoreGardenEvidence, splitEvidenceReferences, validateEvidenceReferences, validateGardenToolInput } from "./garden.js";
import type { GardenReceipt, GardenRequest, GardenUnit, GardenToolInput } from "./garden.js";

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
  readonly gardenUnits?: readonly GardenUnit[];
  readonly pendingGardenRequest?: GardenRequest;
  readonly lastGardenReceipt?: GardenReceipt;
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
  return item.kind === "rabbit-state" && (item.mode === "auto" || item.mode === "manual" || item.mode === "off" || item.mode === "garden" || typeof item.enabled === "boolean") && typeof item.armed === "boolean";
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
    let gardenRequestCounter = 0;
    // Terminal Garden request ids already receipted in this process. Guards
    // duplicate session_compact_failed / onError / lifecycle notifications.
    const settledGardenRequests = new Set<string>();

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
      else if (state.mode === "garden") label = `🐇 garden · ${state.gardenUnits?.filter((unit) => unit.status !== "complete").length ?? 0} units`;
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
    const gardenReceipt = (receipt: GardenReceipt) => {
      state = { ...state, lastGardenReceipt: receipt };
      pi.appendEntry(GARDEN_RECEIPT_ENTRY, receipt);
      persist();
    };
    const gardenUnit = (unitId: string | undefined) => state.gardenUnits?.find((unit) => unit.id === unitId);
    const gardenEvidenceFor = (request: GardenRequest) => request.unitId ? gardenUnit(request.unitId)?.evidenceReferences ?? [] : [];
    const gardenInstructions = (request: GardenRequest) => {
      const unit = request.unitId ? gardenUnit(request.unitId) : undefined;
      return [
        RABBIT_COMPACTION_INSTRUCTIONS,
        "Garden decision: compact using Pi's native compaction path. Preserve the user's exact current intent and authority; current mission and phase; repository, branch, revision and evidence references; completed proof; unresolved questions and hypotheses; and the next gate. Keep concise receipts and references, not copied transcripts. Do not claim unresolved work is complete.",
        `Agent decision: ${request.decision}. Reason: ${request.reason}`,
        `Garden continuity units: ${JSON.stringify(state.gardenUnits ?? [])}`,
        unit ? `Focus on selected unit ${unit.id}: ${unit.summary}.` : "No single unit selected; preserve all recorded mission units.",
        state.config.customInstructions,
      ].filter(Boolean).join("\n\n");
    };
    const gardenEvidenceSplit = (ctx: ExtensionContext, request: GardenRequest) => {
      try {
        return splitEvidenceReferences(ctx.sessionManager.getBranch(), gardenEvidenceFor(request));
      } catch {
        return { verified: [] as string[], unverified: [...gardenEvidenceFor(request)] };
      }
    };
    const failGardenRequest = (ctx: ExtensionContext, requestId: string, reason: string) => {
      const request = state.pendingGardenRequest;
      if (!request || request.requestId !== requestId || settledGardenRequests.has(requestId)) return;
      settledGardenRequests.add(requestId);
      compactionInFlight = false;
      const split = gardenEvidenceSplit(ctx, request);
      const receipt: GardenReceipt = {
        version: 1,
        decision: request.decision,
        status: "failed",
        requestId: request.requestId,
        ...(request.unitId ? { unitId: request.unitId } : {}),
        evidenceReferences: gardenEvidenceFor(request),
        verifiedEvidenceReferences: split.verified,
        unverifiedEvidenceReferences: split.unverified,
        reason: reason.slice(0, 512),
        timestamp: new Date().toISOString(),
      };
      const { pendingGardenRequest: _pendingRequest, ...withoutPendingRequest } = state;
      state = { ...withoutPendingRequest, lastError: reason, lastGardenReceipt: receipt, armed: false };
      pi.appendEntry(GARDEN_RECEIPT_ENTRY, receipt);
      persist();
      publish(ctx);
    };
    const settleQueuedGardenRequest = (ctx: ExtensionContext, status: "cancelled" | "interrupted", reason: string): boolean => {
      const request = state.pendingGardenRequest;
      if (!request || settledGardenRequests.has(request.requestId)) return false;
      settledGardenRequests.add(request.requestId);
      compactionInFlight = false;
      const split = gardenEvidenceSplit(ctx, request);
      const receipt: GardenReceipt = {
        version: 1,
        decision: request.decision,
        status,
        requestId: request.requestId,
        ...(request.unitId ? { unitId: request.unitId } : {}),
        evidenceReferences: gardenEvidenceFor(request),
        verifiedEvidenceReferences: split.verified,
        unverifiedEvidenceReferences: split.unverified,
        reason: reason.slice(0, 512),
        timestamp: new Date().toISOString(),
      };
      const { pendingGardenRequest: _pendingRequest, ...withoutPendingRequest } = state;
      state = { ...withoutPendingRequest, lastGardenReceipt: receipt };
      pi.appendEntry(GARDEN_RECEIPT_ENTRY, receipt);
      persist();
      publish(ctx);
      return true;
    };
    const invalidatePendingGardenRequest = (ctx: ExtensionContext, reason: string): boolean => {
      const request = state.pendingGardenRequest;
      if (!request) return false;
      if (request.status === "in-flight") {
        return settleQueuedGardenRequest(ctx, "interrupted", reason);
      }
      return settleQueuedGardenRequest(ctx, "cancelled", reason);
    };
    const dispatchGardenRequest = (ctx: ExtensionContext): boolean => {
      const request = state.pendingGardenRequest;
      if (!current(ctx) || state.mode !== "garden" || !request || request.status !== "queued" || compactionInFlight) return false;
      if (typeof ctx.compact !== "function") {
        failGardenRequest(ctx, request.requestId, "Pi native compaction is unavailable.");
        return true;
      }
      const operationGeneration = generation;
      const operationSessionId = sessionId;
      const inFlight: GardenRequest = { ...request, status: "in-flight" };
      compactionInFlight = true;
      state = { ...state, pendingGardenRequest: inFlight, lastError: undefined, armed: false };
      const started: GardenReceipt = {
        version: 1, decision: request.decision, status: "started",
        requestId: request.requestId,
        ...(request.unitId ? { unitId: request.unitId } : {}),
        evidenceReferences: gardenEvidenceFor(request), reason: request.reason, timestamp: new Date().toISOString(),
      };
      state = { ...state, lastGardenReceipt: started };
      pi.appendEntry(GARDEN_RECEIPT_ENTRY, started);
      persist();
      publish(ctx);
      const usage = readUsage(ctx, outputReserveTokens(pi, ctx));
      try {
        ctx.compact({
          customInstructions: gardenInstructions(request),
          onComplete: (result) => {
            if (!active || generation !== operationGeneration || sessionId !== operationSessionId || state.pendingGardenRequest?.requestId !== request.requestId || settledGardenRequests.has(request.requestId)) return;
            settledGardenRequests.add(request.requestId);
            compactionInFlight = false;
            const timestamp = new Date().toISOString();
            const after = readUsage(ctx, outputReserveTokens(pi, ctx));
            const split = gardenEvidenceSplit(ctx, request);
            // A completed fold receipt records successful native *context compaction*,
            // never acceptance of the engineering deliverable. Unit completion status
            // is owned exclusively by explicit record decisions (see tool handler).
            const receipt: GardenReceipt = {
              version: 1, decision: request.decision, status: "completed",
              requestId: request.requestId,
              ...(request.unitId ? { unitId: request.unitId } : {}),
              evidenceReferences: gardenEvidenceFor(request),
              verifiedEvidenceReferences: split.verified,
              unverifiedEvidenceReferences: split.unverified,
              ...(request.unitId ? { unresolvedCount: gardenUnit(request.unitId)?.unresolved.length ?? 0 } : {}),
              reason: request.reason, timestamp,
            };
            const sequence = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RECEIPT_ENTRY).length + 1;
            pi.appendEntry(RECEIPT_ENTRY, {
              version: 1, compactionNumber: sequence, trigger: "garden", mode: "garden", reason: request.decision,
              method: completedMethod, provider: ctx.model?.provider ?? null, model: ctx.model?.id ?? null,
              contextWindow: usage?.contextWindow ?? null, beforeTokens: usage?.tokens ?? null, beforePercent: usage?.percent ?? null,
              afterTokens: after?.tokens ?? null, afterPercent: after?.percent ?? null,
              estimatedTokensAfter: result.estimatedTokensAfter ?? null, timestamp,
            });
            // Native compaction never marks a task complete; FOLD requires a pre-completed unit.
            const { pendingGardenRequest: _pendingRequest, ...withoutPendingRequest } = state;
            state = {
              ...withoutPendingRequest, lastGardenReceipt: receipt,
              lastCompactionAt: timestamp, lastEstimatedTokensAfter: result.estimatedTokensAfter,
              lastError: undefined, emergencyRetryEligible: false, armed: false,
            };
            pi.appendEntry(GARDEN_RECEIPT_ENTRY, receipt);
            previousValidTokens = undefined;
            if (after) latestUsage = after;
            persist();
            publish(ctx);
          },
          onError: (error) => failGardenRequest(ctx, request.requestId, error.message),
        });
      } catch (error) {
        failGardenRequest(ctx, request.requestId, error instanceof Error ? error.message : String(error));
      }
      return true;
    };
    const update = (ctx: ExtensionContext) => {
      if (!current(ctx)) return;
      if (dispatchGardenRequest(ctx)) return;
      if (state.mode === "garden") {
        publish(ctx);
        return;
      }
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
      // Queued requests never survive a restart: they lacked fresh authorization.
      // In-flight requests receive an interruption receipt; queued ones a cancellation.
      if (state.pendingGardenRequest) invalidatePendingGardenRequest(ctx, state.pendingGardenRequest.status === "in-flight"
        ? "Garden compaction was interrupted by session restart."
        : "Queued Garden request was cancelled by session restart; request fresh authorization.");
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
      if (state.pendingGardenRequest) invalidatePendingGardenRequest(ctx, state.pendingGardenRequest.status === "in-flight"
        ? "Garden compaction was interrupted by a session tree change."
        : "Queued Garden request was cancelled by a session tree change; request fresh authorization.");
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
      if (state.pendingGardenRequest?.status === "in-flight") {
        failGardenRequest(ctx, state.pendingGardenRequest.requestId, event.errorMessage ?? "Pi compaction failed.");
        return;
      }
      compactionInFlight = false;
      state = { ...state, armed: false, lastError: event.errorMessage ?? "Pi compaction failed." };
      persist();
      publish(ctx);
    });
    pi.registerTool({
      name: "rabbit_garden",
      label: "Rabbit Garden",
      description: "Agent-led context management for the active Pi session. Record or update a continuity unit, defer compaction, fold a completed unit through Pi native compaction, compact the active mission, or restore exact evidence from Pi session entries. Garden mode disables Rabbit's ordinary threshold trigger while keeping Pi's own overflow safety enabled.",
      promptSnippet: "Use Rabbit Garden to decide what context to defer, fold, compact, or restore.",
      promptGuidelines: [
        "Use Garden decisions only when the mission state supports them; DEFER when work is unresolved or evidence is insufficient.",
        "Record concise evidence references and unresolved questions; do not copy transcripts or claim unverified work is complete.",
        "External git:/file:/build: references are unverified pointers, never verified proof; only pi-entry:<entryId> handles confirmed on the active branch count as verified evidence.",
        "FOLD only compacts context for a unit already recorded as complete with no unresolved obligations; it never marks work complete.",
        "Use restore with exact pi-entry:<entryId> references when source evidence is needed.",
      ],
      parameters: Type.Object({
        decision: Type.Union([Type.Literal("status"), Type.Literal("record"), Type.Literal("defer"), Type.Literal("fold"), Type.Literal("compact"), Type.Literal("restore")]),
        unitId: Type.Optional(Type.String({ maxLength: 128 })),
        summary: Type.Optional(Type.String({ maxLength: 512 })),
        status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("deferred"), Type.Literal("complete")])),
        evidenceReferences: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 24 })),
        unresolved: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 24 })),
        reason: Type.Optional(Type.String({ maxLength: 512 })),
      }),      executionMode: "sequential",
      execute: async (_toolCallId, rawInput, _signal, _onUpdate, ctx) => {
        try {
          const input: GardenToolInput = validateGardenToolInput(rawInput);
          if (input.decision !== "status" && state.mode !== "garden") {
            throw new Error("Set Rabbit mode to garden with /rabbit mode garden before making Garden decisions.");
          }
          if (input.decision === "status") {
            const branch = ctx.sessionManager.getBranch();
            const units = (state.gardenUnits ?? []).map((unit) => {
              const split = splitEvidenceReferences(branch, unit.evidenceReferences);
              return { ...unit, verifiedEvidenceReferences: split.verified, unverifiedEvidenceReferences: split.unverified };
            });
            const usage = readUsage(ctx, outputReserveTokens(pi, ctx));
            return { details: undefined, content: [{ type: "text", text: JSON.stringify({ mode: state.mode, contextPercent: usage?.percent ?? null, units, pending: state.pendingGardenRequest ?? null, lastDecision: state.lastGardenReceipt ?? null, evidenceNote: "verifiedEvidenceReferences are pi-entry handles confirmed on the active branch; unverifiedEvidenceReferences are external pointers/claims." }, null, 2) }] };
          }
          if (state.pendingGardenRequest || compactionInFlight) throw new Error("Finish or restart the pending Garden compaction before making another Garden decision.");
          if (input.decision === "restore") {
            const evidence = restoreGardenEvidence(ctx.sessionManager.getBranch(), input.evidenceReferences ?? []);
            const split = splitEvidenceReferences(ctx.sessionManager.getBranch(), input.evidenceReferences ?? []);
            const receipt: GardenReceipt = { version: 1, decision: "restore", status: "restored", ...(input.evidenceReferences ? { evidenceReferences: input.evidenceReferences } : {}), verifiedEvidenceReferences: split.verified, unverifiedEvidenceReferences: split.unverified, timestamp: new Date().toISOString() };
            gardenReceipt(receipt);
            return { details: undefined, content: [{ type: "text", text: evidence }] };
          }
          if (input.decision === "record") {
            const units = [...(state.gardenUnits ?? [])];
            const index = units.findIndex((unit) => unit.id === input.unitId);
            if (index < 0 && units.length >= MAX_GARDEN_UNITS) throw new Error(`Garden stores at most ${MAX_GARDEN_UNITS} continuity units per session.`);
            const previous = index < 0 ? undefined : units[index];
            const effectiveStatus = input.status ?? previous?.status ?? "active";
            const effectiveUnresolved = input.unresolved ?? previous?.unresolved ?? [];
            if (effectiveStatus === "complete" && effectiveUnresolved.length > 0) {
              throw new Error(`Cannot record unit ${JSON.stringify(input.unitId)} as complete while ${effectiveUnresolved.length} unresolved obligation(s) remain; resolve them or record as active/deferred.`);
            }
            const effectiveReferences = input.evidenceReferences ?? previous?.evidenceReferences ?? [];
            const split = validateEvidenceReferences(ctx.sessionManager.getBranch(), effectiveReferences);
            const unit: GardenUnit = {
              id: input.unitId!,
              summary: input.summary!,
              status: effectiveStatus,
              evidenceReferences: effectiveReferences,
              unresolved: [...effectiveUnresolved],
              updatedAt: new Date().toISOString(),
            };
            if (index < 0) units.push(unit); else units[index] = unit;
            if (JSON.stringify(units).length > MAX_GARDEN_STATE_CHARS) throw new Error(`Garden continuity state exceeds ${MAX_GARDEN_STATE_CHARS} characters.`);
            state = { ...state, gardenUnits: units };
            const receipt: GardenReceipt = { version: 1, decision: "record", status: "recorded", unitId: unit.id, evidenceReferences: unit.evidenceReferences, verifiedEvidenceReferences: split.verified, unverifiedEvidenceReferences: split.unverified, unresolvedCount: unit.unresolved.length, timestamp: unit.updatedAt };
            gardenReceipt(receipt);
            return { details: undefined, content: [{ type: "text", text: `Recorded Garden unit ${unit.id} with ${unit.unresolved.length} unresolved item(s); ${split.verified.length} verified native, ${split.unverified.length} unverified pointer(s).` }] };
          }
          const unit = input.unitId ? gardenUnit(input.unitId) : undefined;
          if ((input.decision === "defer" || input.decision === "fold") && !unit) throw new Error(`Garden unit ${JSON.stringify(input.unitId)} was not found; record it before ${input.decision}.`);
          if (input.decision === "fold") {
            if (unit!.status !== "complete") throw new Error(`Fold requires unit ${JSON.stringify(unit!.id)} to be explicitly recorded as complete first; current status is ${JSON.stringify(unit!.status)}. Folding context never marks work complete.`);
            if (unit!.unresolved.length > 0) throw new Error(`Fold requires unit ${JSON.stringify(unit!.id)} to have no unresolved obligations; ${unit!.unresolved.length} remain. Resolve them or defer instead.`);
          }
          if (input.decision === "defer") {
            const units = [...(state.gardenUnits ?? [])];
            const index = units.findIndex((item) => item.id === input.unitId);
            const updated: GardenUnit = { ...unit!, status: "deferred", updatedAt: new Date().toISOString() };
            units[index] = updated;
            state = { ...state, gardenUnits: units };
          }
          if (input.decision === "defer") {
            const split = splitEvidenceReferences(ctx.sessionManager.getBranch(), unit!.evidenceReferences);
            const receipt: GardenReceipt = { version: 1, decision: "defer", status: "deferred", unitId: unit!.id, evidenceReferences: unit!.evidenceReferences, verifiedEvidenceReferences: split.verified, unverifiedEvidenceReferences: split.unverified, unresolvedCount: unit!.unresolved.length, ...(input.reason ? { reason: input.reason } : {}), timestamp: new Date().toISOString() };
            gardenReceipt(receipt);
            return { details: undefined, content: [{ type: "text", text: `Deferred ${unit!.id}; its unresolved state and evidence references remain available.` }] };
          }

          const request: GardenRequest = {
            requestId: `garden-${Date.now()}-${generation}-${(gardenRequestCounter += 1)}`,
            decision: input.decision as "fold" | "compact",
            ...(input.unitId ? { unitId: input.unitId } : {}),
            reason: input.reason!,
            requestedAt: new Date().toISOString(),
            status: "queued",
          };
          state = { ...state, pendingGardenRequest: request };
          const scheduleSplit = splitEvidenceReferences(ctx.sessionManager.getBranch(), gardenEvidenceFor(request));
          const receipt: GardenReceipt = {
            version: 1, decision: request.decision, status: "scheduled",
            requestId: request.requestId,
            ...(request.unitId ? { unitId: request.unitId } : {}),
            evidenceReferences: gardenEvidenceFor(request),
            verifiedEvidenceReferences: scheduleSplit.verified,
            unverifiedEvidenceReferences: scheduleSplit.unverified,
            reason: request.reason, timestamp: request.requestedAt,
          };
          gardenReceipt(receipt);
          publish(ctx);
          return { details: undefined, content: [{ type: "text", text: `Garden ${request.decision} queued for the next Pi turn_end boundary.` }], terminate: true };
        } catch (error) {
          return { details: undefined, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      },
    });
    pi.registerCommand("rabbit", {
      description: "Inspect and configure Rabbit Pi Compactor and Garden mode",
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
            `trigger: ${state.mode === "garden" ? "agent-directed (Pi overflow safety active)" : policy ? `${policy.targetPercent.toFixed(1)}% (${policy.band})` : "waiting for context usage"}`,
            `emergency guard: ${state.mode === "garden" ? "Pi native overflow safety" : policy ? `${policy.emergencyPercent}%` : "unavailable"}`,
            `state: ${compactionInFlight ? "compacting" : state.mode === "garden" ? "awaiting agent decision" : state.armed ? "armed" : "hysteresis"}`,
            `compactions: ${ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RECEIPT_ENTRY).length}`,
            `garden units: ${state.gardenUnits?.length ?? 0}; pending: ${state.pendingGardenRequest?.decision ?? "none"}`,
            `method: ${lastReceipt?.type === "custom" ? (lastReceipt.data as { method?: string }).method ?? "unknown" : "unknown"}`,
            `last compact: ${state.lastCompactionAt ?? "never"}`,
            ...(state.lastEstimatedTokensAfter !== undefined ? [`Pi estimated after: ${state.lastEstimatedTokensAfter.toLocaleString()} tokens`] : []),
            ...(state.lastError ? [`last error: ${state.lastError}`] : []),
          ].join("\n"), "info");
          return;
        }
        if (operation === "on" || operation === "off") {
          const leavingGarden = state.mode === "garden";
          state = { ...state, mode: operation === "off" ? "off" : state.config.thresholdOverride === null ? "auto" : "manual" };
          if (leavingGarden && state.pendingGardenRequest) {
            generation += 1;
            invalidatePendingGardenRequest(ctx, "Queued Garden request was cancelled by leaving Garden mode; request fresh authorization.");
          }
          needsPressureCheck = operation === "on";
          persist();
          publish(ctx);
          ctx.ui.notify(`Rabbit ${operation}.`, "info");
          return;
        }
        if (operation === "cancel") {
          const pending = state.pendingGardenRequest;
          if (!pending) {
            ctx.ui.notify("No queued Garden request to cancel.", "info");
            return;
          }
          if (pending.status !== "queued") {
            ctx.ui.notify("Garden compaction has already started; cancellation is only available before turn_end dispatch.", "warning");
            return;
          }
          generation += 1;
          settleQueuedGardenRequest(ctx, "cancelled", "Queued Garden request was cancelled by /rabbit cancel before execution.");
          persist();
          publish(ctx);
          ctx.ui.notify("Queued Garden request cancelled.", "info");
          return;
        }
        if (operation === "compact") {
          manualCompact(ctx);
          return;
        }
        if (operation === "mode") {
          if (value !== "auto" && value !== "manual" && value !== "off" && value !== "garden") {
            ctx.ui.notify("Usage: /rabbit mode auto|manual|off|garden", "warning");
            return;
          }
          const leavingGarden = state.mode === "garden" && value !== "garden";
          state = {
            ...state,
            mode: value as RabbitMode,
            config: value === "auto"
              ? validateConfig({ ...state.config, thresholdOverride: null })
              : value === "manual" && state.config.thresholdOverride === null
                ? validateConfig({ ...state.config, thresholdOverride: DEFAULT_MANUAL_TRIGGER_PERCENT })
                : state.config,
          };
          if (leavingGarden && state.pendingGardenRequest) {
            // Bump generation so any late callback for the abandoned request can
            // never mutate the new mode/session; the request itself is receipted.
            generation += 1;
            invalidatePendingGardenRequest(ctx, "Queued Garden request was cancelled by leaving Garden mode; request fresh authorization.");
          }
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
        ctx.ui.notify("Usage: /rabbit status|mode auto|manual|off|garden|on|off|compact|cancel|threshold <1-99|adaptive>", "warning");
      },
    });
  };
}
