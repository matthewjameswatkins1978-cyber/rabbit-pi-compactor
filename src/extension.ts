import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
  CompactOptions,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, DEFAULT_MANUAL_TRIGGER_PERCENT, DEFAULT_OUTPUT_RESERVE_TOKENS, crossedThreshold, resolvePolicy, validateConfig } from "./policy.js";
import type { RabbitConfig, RabbitMode } from "./policy.js";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { RABBIT_COMPACTION_INSTRUCTIONS } from "./instructions.js";

import { GARDEN_RECEIPT_ENTRY, MAX_GARDEN_STATE_CHARS, MAX_GARDEN_UNITS, restoreGardenEvidence, splitEvidenceReferences, validateEvidenceReferences, validateGardenToolInput } from "./garden.js";
import type { GardenReceipt, GardenRequest, GardenUnit, GardenToolInput } from "./garden.js";

export const STATE_ENTRY = "rabbit-pi-compactor-state-v1";
export const RECEIPT_ENTRY = "rabbit-pi-compactor-receipt-v1";
export const TRACE_EXPORT_ENTRY = "rabbit-pi-compactor-trace-export-v1";
// Keep in sync with package.json version (patch for fixes, minor for new capabilities).
export const RABBIT_VERSION = "0.2.3";
const STATUS_KEY = "rabbit-compactor";
const MAX_TRACE_EVENTS = 200;
const MAX_TRACE_DETAIL_CHARS = 200;
// Stable failure categories for diagnostics. Raw exception text is untrusted
// (it can carry API keys, user text, or file paths), so exception boundaries
// store and report only these codes. Rabbit's own fixed strings are safe verbatim.
export type RabbitFailureCode = "session-too-small" | "already-compacted" | "compaction-cancelled" | "native-unavailable" | "compaction-failed";
const FAILURE_CODES: readonly RabbitFailureCode[] = ["session-too-small", "already-compacted", "compaction-cancelled", "native-unavailable", "compaction-failed"];
export function classifyFailure(error: unknown): RabbitFailureCode {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
  if ((FAILURE_CODES as readonly string[]).includes(text)) return text as RabbitFailureCode;
  if (/nothing to compact/i.test(text)) return "session-too-small";
  if (/already compacted/i.test(text)) return "already-compacted";
  if (/native compaction is unavailable/i.test(text)) return "native-unavailable";
  if (/cancel/i.test(text)) return "compaction-cancelled";
  return "compaction-failed";
}

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
  return item.kind === "rabbit-state" && (item.mode === "auto" || item.mode === "manual" || item.mode === "off" || item.mode === "garden" || item.mode === "observe" || typeof item.enabled === "boolean") && typeof item.armed === "boolean";
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
    // Bounded in-memory diagnostics. Trace holds sanitised metadata only
    // (kinds, counts, percentages, mode names, request ids, short reasons):
    // never prompts, message bodies, tool output, keys, or credentials.
    type TraceKind =
      | "pressure" | "threshold-decision" | "mode-transition"
      | "queued" | "dispatched" | "native-compact" | "callback-outcome"
      | "session-change" | "cancelled" | "recovery";
    interface TraceEvent {
      readonly seq: number;
      readonly t: string;
      readonly kind: TraceKind;
      readonly detail: string;
      readonly tokens?: number;
      readonly percent?: number;
      readonly requestId?: string;
    }
    let traceEnabled = false;
    let traceSeq = 0;
    const traceEvents: TraceEvent[] = [];
    const trace = (kind: TraceKind, detail: string, extra?: { tokens?: number; percent?: number; requestId?: string }): void => {
      try {
        if (!traceEnabled) return;
        traceSeq += 1;
        traceEvents.push({
          seq: traceSeq,
          t: new Date().toISOString(),
          kind,
          detail: detail.slice(0, MAX_TRACE_DETAIL_CHARS),
          ...(extra?.tokens !== undefined ? { tokens: extra.tokens } : {}),
          ...(extra?.percent !== undefined ? { percent: extra.percent } : {}),
          ...(extra?.requestId !== undefined ? { requestId: extra.requestId.slice(0, 128) } : {}),
        });
        if (traceEvents.length > MAX_TRACE_EVENTS) traceEvents.splice(0, traceEvents.length - MAX_TRACE_EVENTS);
      } catch {
        // Diagnostics must never break compaction behaviour.
      }
    };
    // Physical native-compaction guard. Pi 1.2.0 does not serialize overlapping
    // extension compactions (a second ctx.compact() overwrites the abort
    // controller and runs), so Rabbit retains this guard until terminal
    // acknowledgment: at most one Rabbit-dispatched compaction may be
    // unacknowledged, and no Rabbit dispatch may start while ANY native
    // compaction is observed running. Mode/session transitions never clear it;
    // only the dispatch's own onComplete/onError or an observed native terminal
    // event do. A stuck guard fails closed (no new dispatch, never an overlap).
    interface NativeOp { readonly id: number; }
    let nativeOpCounter = 0;
    let nativeOp: NativeOp | undefined;
    let nativeObserved = false;
    const dispatchNative = (ctx: ExtensionContext, options: CompactOptions): boolean => {
      if (nativeOp || nativeObserved) return false;
      const op: NativeOp = { id: (nativeOpCounter += 1) };
      nativeOp = op;
      const clear = () => { if (nativeOp === op) nativeOp = undefined; };
      const forward: CompactOptions = {
        ...(options.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
        onComplete: (result) => { clear(); options.onComplete?.(result); },
        onError: (error) => { clear(); options.onError?.(error); },
      };
      try {
        ctx.compact(forward);
      } catch (error) { clear(); throw error; }
      return true;
    };

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
      else if (state.mode === "observe") label = "🐇 observe · never compacts";
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
      // Only the current pending request's own terminal notification releases
      // the logical flag. A stale or duplicate notification must not clear the
      // in-flight state belonging to a newer request (the physical guard still
      // prevents any overlap independently).
      if (!request || request.requestId !== requestId || settledGardenRequests.has(requestId)) return;
      compactionInFlight = false;
      settledGardenRequests.add(requestId);
      trace("callback-outcome", `garden ${request.decision} failed: ${reason.slice(0, 120)}`, { requestId });
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
      trace("cancelled", `garden ${request.decision} ${status}: ${reason.slice(0, 120)}`, { requestId: request.requestId });
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
      if (nativeOp || nativeObserved) {
        trace("dispatched", `garden ${request.decision} deferred: native compaction already running`, { requestId: request.requestId });
        publish(ctx);
        return false;
      }
      const operationGeneration = generation;
      const operationSessionId = sessionId;
      const inFlight: GardenRequest = { ...request, status: "in-flight" };
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
      trace("dispatched", `garden ${request.decision} dispatched to native compaction`, {
        requestId: request.requestId,
        ...(usage?.tokens !== undefined ? { tokens: usage.tokens } : {}),
        ...(usage?.percent !== undefined ? { percent: usage.percent } : {}),
      });
      try {
        const gardenStarted = dispatchNative(ctx, {
          customInstructions: gardenInstructions(request),
          onComplete: (result) => {
            compactionInFlight = false;
            if (!active || generation !== operationGeneration || sessionId !== operationSessionId || state.pendingGardenRequest?.requestId !== request.requestId || settledGardenRequests.has(request.requestId)) return;
            settledGardenRequests.add(request.requestId);
            trace("callback-outcome", `garden ${request.decision} completed`, { requestId: request.requestId });
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
          onError: (error) => failGardenRequest(ctx, request.requestId, classifyFailure(error)),
        });
        if (!gardenStarted) {
          // Unreachable while the pre-dispatch gate above holds (single-threaded);
          // restore the queued request truthfully rather than stranding it in-flight.
          state = { ...state, pendingGardenRequest: request };
          trace("dispatched", `garden ${request.decision} deferred: native compaction already running`, { requestId: request.requestId });
          publish(ctx);
          return false;
        }
        compactionInFlight = true;
      } catch (error) {
        failGardenRequest(ctx, request.requestId, classifyFailure(error));
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
      if (state.mode === "observe") {
        // Observe mode records pressure for diagnostics but never compacts.
        const observed = readUsage(ctx, outputReserveTokens(pi, ctx));
        if (observed) {
          latestUsage = observed;
          previousValidTokens = observed.tokens;
          trace("pressure", `observed ${observed.percent.toFixed(1)}% effective; never compacts`, { tokens: observed.tokens, percent: observed.percent });
        } else {
          previousValidTokens = undefined;
          trace("pressure", "usage unknown; never compacts");
        }
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

      trace("threshold-decision", `${state.mode} crossed ${policy.targetPercent.toFixed(0)}% at ${usage.percent.toFixed(1)}%${emergency ? " (emergency)" : ""}; requesting native compaction`, { tokens: usage.tokens, percent: usage.percent });
      const operationGeneration = generation;
      const operationSessionId = sessionId;
      state = {
        ...state,
        armed: false,
        lastError: undefined,
        emergencyRetryEligible: state.mode === "auto" && !emergency,
      };
      persist();
      publish(ctx);
      try {
        const autoStarted = dispatchNative(ctx, {
          customInstructions: [
            RABBIT_COMPACTION_INSTRUCTIONS,
            state.config.customInstructions,
          ].filter(Boolean).join("\n\n"),
          onComplete: (result) => {
            compactionInFlight = false;
            if (!active || generation !== operationGeneration || sessionId !== operationSessionId) return;
            trace("callback-outcome", `${state.mode} compaction completed`);
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
            const failureCode = classifyFailure(error);
            compactionInFlight = false;
            if (!active || generation !== operationGeneration || sessionId !== operationSessionId) return;
            trace("callback-outcome", `${state.mode} compaction failed [${failureCode}]`);
            state = { ...state, armed: false, lastError: failureCode };
            persist();
            publish(ctx);
            if (ctx.hasUI) ctx.ui.notify(`🐇 Compaction failed [${failureCode}].`, "warning");
          },
        });
        if (!autoStarted) {
          trace("threshold-decision", `${state.mode} at ${usage.percent.toFixed(1)}% deferred: native compaction already running`);
          publish(ctx);
          return;
        }
        compactionInFlight = true;
      } catch (error) {
        const autoCatchCode = classifyFailure(error);
        compactionInFlight = false;
        trace("callback-outcome", `${state.mode} compaction failed [${autoCatchCode}]`);
        state = { ...state, armed: false, lastError: autoCatchCode };
        persist();
        publish(ctx);
      }
    };
    const manualCompact = (ctx: ExtensionCommandContext) => {
      if (state.mode === "observe") {
        ctx.ui.notify("Rabbit Observe mode never requests compaction; switch modes to compact.", "warning");
        return;
      }
      if (nativeOp || nativeObserved) {
        ctx.ui.notify("Rabbit cannot compact while a native compaction is already running.", "warning");
        return;
      }
      if (!ctx.isIdle() || compactionInFlight || typeof ctx.compact !== "function") {
        ctx.ui.notify("Rabbit cannot compact while Pi is busy or compaction is unavailable.", "warning");
        return;
      }
      state = { ...state, armed: false, emergencyRetryEligible: false };
      const beforeUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
      const manualPolicy = resolvePolicy(beforeUsage?.contextWindow, state.config, beforeUsage?.reserveTokens);
      const sequence = ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RECEIPT_ENTRY).length + 1;
      persist();
      publish(ctx);
      const operationGeneration = generation;
      const operationSessionId = sessionId;
      try {
        const manualStarted = dispatchNative(ctx, {
        customInstructions: [RABBIT_COMPACTION_INSTRUCTIONS, state.config.customInstructions]
          .filter(Boolean).join("\n\n"),
        onComplete: (result) => {
          compactionInFlight = false;
          if (generation !== operationGeneration || sessionId !== operationSessionId) return;
          trace("callback-outcome", "manual compaction completed");
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
          const manualFailure = classifyFailure(error);
          compactionInFlight = false;
          if (generation !== operationGeneration || sessionId !== operationSessionId) return;
          trace("callback-outcome", `manual compaction failed [${manualFailure}]`);
          state = { ...state, armed: false, lastError: manualFailure };
          persist();
          publish(ctx);
        },
      });
      if (!manualStarted) {
        publish(ctx);
        return;
      }
      compactionInFlight = true;
      // Compact is fire-and-forget; synchronous failures still need visible status.
      } catch (error) {
        const manualCatchCode = classifyFailure(error);
        compactionInFlight = false;
        trace("callback-outcome", `manual compaction failed [${manualCatchCode}]`);
        state = { ...state, armed: false, lastError: manualCatchCode };
        persist();
        publish(ctx);
      }
    };

    pi.on("session_start", (_event, ctx) => {
      generation += 1;
      trace("session-change", "session_start; queued Garden work never survives restart");
      // A session boundary replaces Pi's per-session compaction controllers, so
      // any pre-boundary native op is dead or belongs to a dead session: the
      // physical guard restarts fresh here. Same-session transitions (mode,
      // threshold, manual) never reset it. Stale terminals clear idempotently.
      nativeOp = undefined;
      nativeObserved = false;
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
      trace("session-change", "session_tree; queued Garden work never survives tree change");
      // Same-session tree object or replacement: either way the pre-change op
      // cannot still own the current wire; see session_start above.
      nativeOp = undefined;
      nativeObserved = false;
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
      trace("session-change", "session_shutdown");
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
      trace("recovery", "model changed; crossing baseline reset and rearmed");
      state = { ...state, armed: true };
      state = { ...state, emergencyAttempted: false, emergencyRetryEligible: false };
      needsPressureCheck = true;
      persist();
      publish(ctx);
    });
    pi.on("session_before_compact", (event, ctx) => {
      // Passive observer only: Rabbit never cancels or rewrites native compaction.
      if (!current(ctx)) return;
      nativeObserved = true;
      trace("native-compact", `before-compact reason=${event.reason} willRetry=${event.willRetry}`);
    });
    pi.on("session_compact", (event, ctx) => {
      if (!current(ctx)) return;
      nativeObserved = false;
      trace("native-compact", `compacted reason=${event.reason} fromExtension=${event.fromExtension} willRetry=${event.willRetry}`);
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
      if (!current(ctx)) return;
      nativeObserved = false;
      // Native failures are traced with a stable code even when Rabbit owns no
      // request (e.g. Observe mode): observation only, never a Rabbit receipt.
      trace("callback-outcome", `native compaction failed reason=${event.reason} aborted=${event.aborted} code=${event.aborted ? "compaction-cancelled" : classifyFailure(event.errorMessage ?? "Pi compaction failed.")}`);
      if (!compactionInFlight) return;
      if (state.pendingGardenRequest?.status === "in-flight") {
        failGardenRequest(ctx, state.pendingGardenRequest.requestId, classifyFailure(event.errorMessage ?? "Pi compaction failed."));
        return;
      }
      compactionInFlight = false;
      state = { ...state, armed: false, lastError: classifyFailure(event.errorMessage ?? "Pi compaction failed.") };
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
          if (state.mode === "observe" && (input.decision === "fold" || input.decision === "compact")) {
            throw new Error("Rabbit Observe mode never requests compaction; switch to garden to queue compaction.");
          }
          if (input.decision !== "status" && state.mode !== "garden" && state.mode !== "observe") {
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
          trace("queued", `garden ${request.decision} queued for the next Pi turn_end boundary`, { requestId: request.requestId });
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
        const [requestedOperation, value, extra] = args.trim().split(/\s+/, 3);
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
            `trigger: ${state.mode === "garden" ? "agent-directed (Pi overflow safety active)" : state.mode === "observe" ? "observe (never compacts; Pi overflow safety active)" : policy ? `${policy.targetPercent.toFixed(1)}% (${policy.band})` : "waiting for context usage"}`,
            `emergency guard: ${state.mode === "garden" ? "Pi native overflow safety" : policy ? `${policy.emergencyPercent}%` : "unavailable"}`,
            `state: ${compactionInFlight ? "compacting" : state.mode === "garden" ? "awaiting agent decision" : state.armed ? "armed" : "hysteresis"}`,
            `compactions: ${ctx.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === RECEIPT_ENTRY).length}`,
            `garden units: ${state.gardenUnits?.length ?? 0}; pending: ${state.pendingGardenRequest?.decision ?? "none"}`,
            `method: ${lastReceipt?.type === "custom" ? (lastReceipt.data as { method?: string }).method ?? "unknown" : "unknown"}`,
            `last compact: ${state.lastCompactionAt ?? "never"}`,
            ...(state.lastEstimatedTokensAfter !== undefined ? [`Pi estimated after: ${state.lastEstimatedTokensAfter.toLocaleString()} tokens`] : []),
            ...(state.lastError ? [`last error: ${classifyFailure(state.lastError)}`] : []),
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
          if (value !== "auto" && value !== "manual" && value !== "off" && value !== "garden" && value !== "observe") {
            ctx.ui.notify("Usage: /rabbit mode auto|manual|off|garden|observe", "warning");
            return;
          }
          const previousMode = state.mode;
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
          trace("mode-transition", `${previousMode} -> ${value}`);
          return;
        }
        if (operation === "threshold") {
          try {
            const thresholdOverride = value === "adaptive" ? null : Number(value);
            const thresholdPreviousMode = state.mode;
            state = { ...state, mode: value === "adaptive" ? "auto" : "manual", config: validateConfig({ ...state.config, thresholdOverride }) };
            if (thresholdPreviousMode === "garden" && state.pendingGardenRequest) {
              // Same guarantee as /rabbit mode: leaving Garden never carries a queued request.
              generation += 1;
              invalidatePendingGardenRequest(ctx, "Queued Garden request was cancelled by leaving Garden mode; request fresh authorization.");
            }
            trace("mode-transition", `threshold ${thresholdPreviousMode} -> ${state.mode}`);
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
        if (operation === "doctor") {
          const currentUsage = readUsage(ctx, outputReserveTokens(pi, ctx));
          if (currentUsage) latestUsage = currentUsage;
          const usage = currentUsage ?? latestUsage;
          const policy = resolvePolicy(usage?.contextWindow, state.config, usage?.reserveTokens);
          const branch = (() => { try { return ctx.sessionManager.getBranch(); } catch { return []; } })();
          const receiptCount = branch.filter((entry) => entry.type === "custom" && entry.customType === RECEIPT_ENTRY).length;
          const report = {
            rabbit: RABBIT_VERSION,
            observed: {
              mode: state.mode,
              sessionMatch: current(ctx),
              compactionInFlight,
              armed: state.armed,
              pendingGardenRequest: state.pendingGardenRequest?.status ?? "none",
              nativeCompactAvailable: typeof ctx.compact === "function",
              model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
              receiptCount,
              traceEventsCaptured: traceEvents.length,
            },
            estimated: {
              contextPercent: usage ? Number(usage.percent.toFixed(1)) : null,
              contextTokens: usage?.tokens ?? null,
              effectiveBudget: policy?.effectiveBudget ?? null,
              lastEstimatedTokensAfter: state.lastEstimatedTokensAfter ?? null,
            },
            inferred: {
              trigger: state.mode === "observe" || state.mode === "garden" ? "agent-directed or none (Pi overflow safety active)" : policy ? `${policy.targetPercent}% of effective budget` : "waiting for first measurement",
              rearm: state.armed ? "armed" : "hysteresis until usage recovers",
            },
            missing: [
              ...(usage ? [] : ["no context-usage measurement yet"]),
              ...(policy ? [] : ["no compaction policy (unknown context window)"]),
              ...(state.lastCompactionAt ? [] : ["no compaction observed yet"]),
            ],
            safety: [
              "Pi owns summarisation, retention, overflow recovery, and safety compaction; Rabbit never replaces them",
              "Rabbit never disables Pi native automatic compaction",
              "Queued Garden requests never survive restart, tree change, or leaving Garden mode",
              "Unknown measurements never count as zero and never trigger",
              ...(state.mode === "observe" ? ["Observe mode never requests compaction"] : []),
            ],
            ...(state.lastError ? { lastError: classifyFailure(state.lastError) } : {}),
          };
          ctx.ui.notify(`RABBIT DOCTOR\n${JSON.stringify(report, null, 2).slice(0, 8000)}`, "info");
          return;
        }
        if (operation === "trace") {
          if (value === "on") {
            traceEnabled = true;
            ctx.ui.notify("Rabbit trace capture on (bounded sanitised metadata only).", "info");
            return;
          }
          if (value === "off") {
            traceEnabled = false;
            ctx.ui.notify(`Rabbit trace capture off; retained ${traceEvents.length} bounded event(s).`, "info");
            return;
          }
          if (value === "export" || value === undefined) {
            const report = {
              version: 1,
              rabbit: RABBIT_VERSION,
              exportedAt: new Date().toISOString(),
              captureEnabled: traceEnabled,
              mode: state.mode,
              eventCount: traceEvents.length,
              retainedCapacity: MAX_TRACE_EVENTS,
              observed: "events below are recorded extension callbacks and decisions",
              estimated: "token/percent fields are Pi measurements or Pi estimates, not exact usage",
              inferred: "ordering follows callback arrival; native internals are not visible",
              missing: traceEnabled ? [] : ["capture was off for some or all of this session; enable with /rabbit trace on"],
              events: traceEvents,
            };
            const text = JSON.stringify(report, null, 2);
            try {
              pi.appendEntry(TRACE_EXPORT_ENTRY, { ...report, events: report.events.slice(-50) });
            } catch {
              // Session history may be unavailable; the notify channel still carries the report.
            }
            ctx.ui.notify(`RABBIT TRACE EXPORT (${report.eventCount} event(s), capacity ${MAX_TRACE_EVENTS})\n${text.slice(0, 12000)}`, "info");
            if (value === "export" && extra) {
              try {
                // Strict allowlist for ordinary .json filenames inside the Pi working
                // directory. Anything else is refused before touching the filesystem:
                // separators or drive syntax could traverse a symlink/junction parent,
                // a colon denotes an NTFS alternate data stream rather than a new file,
                // and bare device names address devices rather than files.
                if (
                  typeof extra !== "string" ||
                  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(extra) ||
                  /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\..*)?$/i.test(extra)
                ) {
                  throw Object.assign(new Error("export-refused"), { code: "EXPORT_OUTSIDE_CWD" });
                }
                const resolved = path.join(ctx.cwd, extra);
                fs.writeFileSync(resolved, text, { encoding: "utf8", flag: "wx" });
                ctx.ui.notify(`Rabbit trace report written to ${resolved}.`, "info");
              } catch (error) {
                const code = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
                  ? (error as NodeJS.ErrnoException).code as string
                  : "export-failed";
                if (code === "EEXIST") {
                  ctx.ui.notify("Rabbit trace export refused: that file already exists; remove it or choose another name.", "warning");
                } else if (code === "EXPORT_OUTSIDE_CWD") {
                  ctx.ui.notify("Rabbit trace export refused: destination must be a relative path inside the Pi working directory.", "warning");
                } else {
                  ctx.ui.notify(`Rabbit trace export failed [${code}]; no file was modified.`, "warning");
                }
              }
            }
            return;
          }
          ctx.ui.notify("Usage: /rabbit trace on|off|export [name]", "warning");
          return;
        }
        ctx.ui.notify("Usage: /rabbit status|mode auto|manual|off|garden|observe|on|off|compact|cancel|threshold <1-99|adaptive>|doctor|trace on|off|export [path]", "warning");
      },
    });
  };
}
