import assert from "node:assert/strict";
import test from "node:test";
import {
  createRabbitExtension,
  crossedThreshold,
  DEFAULT_CONFIG,
  resolvePolicy,
  validateConfig,
  RECEIPT_ENTRY,
} from "../dist/index.js";
import { serializeConversation } from "@earendil-works/pi-coding-agent";

function harness(initialTokens = 300_000, contextWindow = 1_000_000) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const compactCalls = [];
  const statuses = new Map();
  let sessionId = "session-1";
  let tokens = initialTokens;
  let window = contextWindow;
  let provider = "meta";
  let modelId = "muse-spark-1.3-contributor";
  let settings = {};
  let quotaPercent = 0;
  const context = {
    get hasUI() { return true; },
    get model() { return { provider, id: modelId }; },
    getContextUsage: () => ({ tokens, contextWindow: window, percent: tokens === null ? null : (tokens / window) * 100, quotaPercent }),
    get isIdle() { return () => true; },
    get sessionManager() { return { getSessionId: () => sessionId, getBranch: () => entries }; },
    compact: (options) => compactCalls.push(options),
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: () => {},
    },
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command.handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    getSettings: () => settings,
  };
  createRabbitExtension()(pi);
  const emit = (event, ctx = context) => handlers.get(event)?.({}, ctx);
  const setUsage = (nextTokens, nextWindow = window) => { tokens = nextTokens; window = nextWindow; };
  const setSettings = (next) => { settings = next; };
  const setQuotaPercent = (next) => { quotaPercent = next; };
  const setModel = (nextProvider, nextId) => { provider = nextProvider; modelId = nextId; };
  const replaceSession = (next) => { sessionId = next; };
  return { context, commands, compactCalls, emit, entries, replaceSession, setModel, setQuotaPercent, setSettings, setUsage, statuses, tools };
}

test("Auto uses 88% of Pi's effective budget across model windows", () => {
  for (const window of [32_768, 131_072, 204_800, 262_144, 1_000_000]) {
    const policy = resolvePolicy(window);
    assert.equal(policy?.targetPercent, 88);
    assert.equal(policy?.targetTokens, Math.ceil((window - 16_384) * 0.88));
    assert.equal(policy?.emergencyPercent, 96);
    assert.equal(policy?.emergencyTokens, Math.ceil((window - 16_384) * 0.96));
    assert.equal(policy?.effectiveBudget, window - 16_384);
  }
  assert.equal(resolvePolicy(undefined), undefined);
});

test("legacy 90% to 35% interpolation is recorded independently of current policy", () => {
  const legacy = (window) => {
    if (window <= 131_072) return 90;
    if (window >= 262_144) return 35;
    return 90 + ((window - 131_072) / (262_144 - 131_072)) * (35 - 90);
  };
  assert.deepEqual([131_072, 163_840, 196_608, 229_376, 262_144].map(legacy), [90, 76.25, 62.5, 48.75, 35]);
});
test("configuration supports override and rejects unsafe values", () => {
  const config = validateConfig({ thresholdOverride: 42 });
  assert.equal(resolvePolicy(1_000_000, config)?.targetPercent, 42);
  assert.equal(resolvePolicy(1_000_000, validateConfig({ thresholdOverride: null }))?.targetPercent, 88);
  assert.equal(validateConfig({ thresholdOverride: 99 }).thresholdOverride, 99);
  assert.throws(() => validateConfig({ thresholdOverride: 100 }));
  assert.throws(() => validateConfig({ thresholdOverride: 99.5 }));
});

test("output reserve reduces usable capacity without changing Pi retention settings", () => {
  const policy = resolvePolicy(100_000, validateConfig({ thresholdOverride: 99 }), 20_000);
  assert.equal(policy.effectiveBudget, 80_000);
  assert.equal(policy.targetTokens, 79_200);
  assert.equal(policy.reserveTokens, 20_000);
});

test("threshold crossing compacts once, receipts the result, and rearms below hysteresis", () => {
  const target = Math.ceil((1_000_000 - 16_384) * 0.88);
  const h = harness(340_000);
  h.emit("session_start");
  h.setUsage(target);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "exact threshold is not above it");
  h.setUsage(target + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  assert.equal("keepRecentTokens" in h.compactCalls[0], false, "Pi remains the owner of recent-tail retention");
  h.setUsage(target + 10_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "staying above must not repeat");
  h.setUsage(28_000);
  h.emit("session_compact");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 28_000 });
  const receipt = h.entries.find((entry) => entry.customType === RECEIPT_ENTRY)?.data;
  assert.equal(receipt.trigger, "auto");
  assert.equal(receipt.method, "pi-local");
  assert.equal(receipt.compactionNumber, 1);
  assert.equal(receipt.effectiveBudget, 983_616);
  assert.equal(receipt.outputReserveTokens, 16_384);
  assert.equal(receipt.estimatedTokensAfter, 28_000);
  assert.equal(receipt.afterTokens, 28_000);
  assert.equal(receipt.mode, "auto");
  h.setUsage(target - Math.ceil(983_616 * 0.05) - 1);
  h.emit("turn_end");
  h.setUsage(target);
  h.emit("turn_end");
  h.setUsage(target + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2, "rearms below 30%, then requires a new crossing");
});

test("Rabbit supports at least three compactions in one run", () => {
  const target = Math.ceil((1_000_000 - 16_384) * 0.88);
  const h = harness(300_000);
  h.emit("session_start");
  for (let number = 1; number <= 3; number += 1) {
    h.setUsage(target);
    h.emit("turn_end");
    h.setUsage(target + 1);
    h.emit("turn_end");
    const operation = h.compactCalls.at(-1);
    assert.ok(operation);
    operation.onComplete({ estimatedTokensAfter: 30_000 });
    const receipts = h.entries.filter((entry) => entry.customType === RECEIPT_ENTRY);
    assert.equal(receipts.at(-1).data.compactionNumber, number);
    if (number < 3) {
      h.setUsage(target - Math.ceil(983_616 * 0.05) - 1);
      h.emit("turn_end");
    }
  }
  assert.equal(h.compactCalls.length, 3);
});

test("unknown usage does not trigger, and model changes reset the crossing baseline", () => {
  const h = harness(300_000);
  h.emit("session_start");
  h.setUsage(null);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
  h.setUsage(351_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "no crossing can be inferred across unknown usage");
  h.setUsage(40_000, 65_536);
  h.emit("model_select");
  const smallTarget = Math.ceil((65_536 - 16_384) * 0.88);
  h.setUsage(smallTarget, 65_536);
  h.emit("turn_end");
  h.setUsage(smallTarget + 1, 65_536);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 20_000 });
  h.setUsage(800_000, 1_000_000);
  h.emit("model_select");
  const largeTarget = Math.ceil((1_000_000 - 16_384) * 0.88);
  h.setUsage(largeTarget, 1_000_000);
  h.emit("turn_end");
  h.setUsage(largeTarget, 1_000_000);
  h.emit("turn_end");
  h.setUsage(largeTarget + 1, 1_000_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2, "a larger selected model gets a fresh capacity-based threshold");
});

test("switching from a 1M route to 128k triggers against the new window immediately", () => {
  const h = harness(330_000);
  h.emit("session_start");
  h.setUsage(104_000, 128_000);
  h.emit("model_select");
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
});

test("manual requests overlapping automatic compaction do not duplicate it", () => {
  const target = Math.ceil(983_616 * 0.88);
  const h = harness(300_000);
  h.emit("session_start");
  h.setUsage(target + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);

  h.commands.get("rabbit")("compact", h.context);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "manual and automatic requests share the in-flight compaction");

  h.setUsage(25_000);
  h.emit("session_compact");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 25_000 });
  const receipts = h.entries.filter((entry) => entry.customType === RECEIPT_ENTRY);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].data.trigger, "auto");
  assert.equal(receipts[0].data.compactionNumber, 1);
});

test("native compaction disarms and the manual command uses Pi compact", () => {
  const h = harness(866_000);
  h.emit("session_start");
  h.emit("session_compact");
  h.setUsage(920_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
  h.commands.get("rabbit")("compact", h.context);
  assert.equal(h.compactCalls.length, 1);
});

test("disable command prevents automatic compaction", () => {
  const h = harness(340_000);
  h.emit("session_start");
  h.commands.get("rabbit")("off", h.context);
  h.setUsage(Math.ceil((1_000_000 - 16_384) * 0.88) + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
  assert.match(h.statuses.get("rabbit-compactor"), /off/);
});

test("model-specific output reserve override is used for the selected route", () => {
  const h = harness(60_000, 100_000);
  h.setSettings({ compaction: { reserveTokens: 16_384, modelOverrides: { "meta/muse-spark-1.3-contributor": { reserveTokens: 20_000 } } } });
  h.emit("session_start");
  const target = Math.ceil(80_000 * 0.88);
  h.setUsage(target, 100_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
  h.setUsage(target + 1, 100_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.setUsage(20_000, 100_000);
  h.emit("session_compact");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 20_000 });
  const receipt = h.entries.find((entry) => entry.customType === RECEIPT_ENTRY).data;
  assert.equal(receipt.outputReserveTokens, 20_000);
  assert.equal(receipt.effectiveBudget, 80_000);
  assert.equal(receipt.afterPercent, 25);
});

test("provider quota percentage is ignored by context pressure calculations", () => {
  const h = harness(300_000);
  h.emit("session_start");
  const target = Math.ceil(983_616 * 0.88);
  h.setQuotaPercent(149);
  h.setUsage(target + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.setQuotaPercent(150);
  h.setUsage(30_000);
  h.emit("session_compact");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 30_000 });
  assert.equal(h.entries.filter((entry) => entry.customType === RECEIPT_ENTRY)[0].data.beforeTokens, target + 1);
});

test("mode Auto, Manual, and Off persist across session restart", () => {
  const h = harness(100_000);
  h.emit("session_start");
  h.commands.get("rabbit")("threshold 99", h.context);
  assert.equal(h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-state-v1").at(-1).data.mode, "manual");
  h.emit("session_shutdown");
  h.emit("session_start");
  h.commands.get("rabbit")("off", h.context);
  h.emit("session_shutdown");
  h.emit("session_start");
  assert.equal(h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-state-v1").at(-1).data.mode, "off");
  h.commands.get("rabbit")("mode auto", h.context);
  assert.equal(h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-state-v1").at(-1).data.mode, "auto");
  h.commands.get("rabbit")("mode manual", h.context);
  assert.equal(h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-state-v1").at(-1).data.config.thresholdOverride, 90);
});

test("manual compaction writes a sequence receipt with measured before and after values", () => {
  const h = harness(250_000, 300_000);
  h.emit("session_start");
  h.commands.get("rabbit")("compact", h.context);
  h.setUsage(18_000, 300_000);
  h.emit("session_compact");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 18_500 });
  const receipt = h.entries.find((entry) => entry.customType === RECEIPT_ENTRY).data;
  assert.equal(receipt.compactionNumber, 1);
  assert.equal(receipt.trigger, "manual");
  assert.equal(receipt.reason, "manual");
  assert.equal(receipt.beforeTokens, 250_000);
  assert.equal(receipt.afterTokens, 18_000);
  assert.equal(receipt.estimatedTokensAfter, 18_500);
});

test("a jump past the emergency guard is identified in the receipt", () => {
  const h = harness(300_000);
  h.emit("session_start");
  h.setUsage(950_000);
  h.emit("turn_end");
  h.setUsage(950_001);
  h.emit("turn_end");
  h.setUsage(30_000);
  h.emit("session_compact");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 30_000 });
  const receipt = h.entries.find((entry) => entry.customType === RECEIPT_ENTRY).data;
  assert.equal(receipt.reason, "emergency");
});

test("one failed normal attempt can retry once at the emergency guard", () => {
  const h = harness(300_000);
  h.emit("session_start");
  const target = Math.ceil(983_616 * 0.88);
  const emergency = Math.ceil(983_616 * 0.96);
  h.setUsage(target + 1);
  h.emit("turn_end");
  h.compactCalls[0].onError(new Error("normal attempt failed"));
  h.setUsage(emergency);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "guard threshold itself does not cross");
  h.setUsage(emergency + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2);
  h.compactCalls[1].onError(new Error("emergency attempt failed"));
  h.setUsage(emergency + 100);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2, "emergency retry is bounded to one attempt");
});

test("manual compaction failure does not activate the automatic emergency retry", () => {
  const h = harness(300_000);
  h.emit("session_start");
  h.commands.get("rabbit")("compact", h.context);
  h.compactCalls[0].onError(new Error("manual attempt failed"));
  const emergency = Math.ceil(983_616 * 0.96);
  h.setUsage(emergency);
  h.emit("turn_end");
  h.setUsage(emergency + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
});

test("receipt sequence and armed state survive restart after a compaction", () => {
  const h = harness(300_000);
  const target = Math.ceil(983_616 * 0.88);
  h.emit("session_start");
  h.setUsage(target + 1);
  h.emit("turn_end");
  h.setUsage(25_000);
  h.emit("session_compact");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 25_000 });
  h.emit("session_shutdown");
  h.emit("session_start");
  h.setUsage(target);
  h.emit("turn_end");
  h.setUsage(target + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2);
  h.setUsage(25_000);
  h.emit("session_compact");
  h.compactCalls[1].onComplete({ estimatedTokensAfter: 25_000 });
  assert.equal(h.entries.filter((entry) => entry.customType === RECEIPT_ENTRY).at(-1).data.compactionNumber, 2);
});

test("unavailable native compaction API fails safely", () => {
  const h = harness(340_000);
  h.emit("session_start");
  h.context.compact = undefined;
  h.setUsage(Math.ceil((1_000_000 - 16_384) * 0.88) + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
});

test("failed compaction stays disarmed until safe rearm", () => {
  const h = harness(340_000);
  h.emit("session_start");
  const target = Math.ceil((1_000_000 - 16_384) * 0.88);
  h.setUsage(target + 1);
  h.emit("turn_end");
  h.compactCalls[0].onError(new Error("test failure"));
  h.setUsage(920_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.setUsage(target - Math.ceil(983_616 * 0.05) - 1);
  h.emit("turn_end");
  h.setUsage(target + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2);
});

test("session shutdown invalidates callbacks from the old session", () => {
  const h = harness(340_000);
  h.emit("session_start");
  h.setUsage(Math.ceil((1_000_000 - 16_384) * 0.88) + 1);
  h.emit("turn_end");
  const staleCompletion = h.compactCalls[0].onComplete;
  h.emit("session_shutdown");
  h.replaceSession("session-2");
  h.emit("session_start");
  staleCompletion({ estimatedTokensAfter: 12_000 });
  assert.equal(h.entries.some((entry) => entry.customType === RECEIPT_ENTRY), false);
});

test("Terror Bat: native Pi summary serialization truncates tool results after 2,000 characters", () => {
  const criticalBefore = "CRITICAL_BEFORE_2000";
  const criticalAfter = "CRITICAL_AFTER_2000";
  const toolOutput = `${criticalBefore}${"x".repeat(2_000)}${criticalAfter}`;
  const serialized = serializeConversation([
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: toolOutput }],
      isError: false,
      timestamp: 1,
    },
  ]);
  assert.match(serialized, new RegExp(criticalBefore));
  assert.doesNotMatch(serialized, new RegExp(criticalAfter));
  assert.match(serialized, /characters truncated/);
});
test("Garden deferral is agent-owned and ordinary Rabbit threshold policy stays inactive", async () => {
  const h = harness(300_000);
  h.emit("session_start");
  await h.commands.get("rabbit")("mode garden", h.context);
  const tool = h.tools.get("rabbit_garden");
  assert.ok(tool);
  await tool.execute("record", {
    decision: "record",
    unitId: "unresolved-contract",
    summary: "Check the external API contract before changing the adapter.",
    evidenceReferences: ["git:main@a1b2c3d:packages/adapter.ts"],
    unresolved: ["Confirm upstream parameter semantics."],
  }, undefined, undefined, h.context);
  const deferred = await tool.execute("defer", {
    decision: "defer",
    unitId: "unresolved-contract",
    reason: "Keep the coupled investigation intact until the API owner is checked.",
  }, undefined, undefined, h.context);
  assert.match(deferred.content[0].text, /deferred/i);
  h.setUsage(Math.ceil((1_000_000 - 16_384) * 0.88) + 1);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "Garden never overrides a valid DEFER with the ordinary threshold");
  const state = h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-state-v1").at(-1).data;
  assert.equal(state.mode, "garden");
  assert.equal(state.gardenUnits[0].status, "deferred");
  assert.deepEqual(state.gardenUnits[0].unresolved, ["Confirm upstream parameter semantics."]);
  assert.equal(state.lastGardenReceipt.decision, "defer");
});

test("Garden folds through Pi compaction only at turn_end and receipts the accepted unit", async () => {
  const h = harness(300_000);
  h.emit("session_start");
  await h.commands.get("rabbit")("mode garden", h.context);
  const tool = h.tools.get("rabbit_garden");
  // FOLD requires a unit already explicitly accepted as complete with no
  // unresolved obligations; folding context never manufactures completion.
  await tool.execute("record", {
    decision: "record",
    unitId: "phase-a",
    summary: "Phase A acceptance is complete; proof retained.",
    status: "complete",
    evidenceReferences: ["git:feature/phase-a@abc123:src/"],
    unresolved: [],
  }, undefined, undefined, h.context);
  const scheduled = await tool.execute("fold", {
    decision: "fold",
    unitId: "phase-a",
    reason: "The accepted implementation is stable; retain its proof and next gate.",
  }, undefined, undefined, h.context);
  assert.equal(scheduled.terminate, true);
  assert.equal(h.compactCalls.length, 0, "tool execution only schedules the operation");
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  assert.match(h.compactCalls[0].customInstructions, /phase-a/);
  assert.match(h.compactCalls[0].customInstructions, /unresolved/);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "one request cannot be dispatched twice while in flight");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 27_000 });
  const receipt = h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-garden-receipt-v1").at(-1)?.data;
  assert.equal(receipt.decision, "fold");
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.unitId, "phase-a");
  assert.deepEqual(receipt.evidenceReferences, ["git:feature/phase-a@abc123:src/"]);
  assert.deepEqual(receipt.unverifiedEvidenceReferences, ["git:feature/phase-a@abc123:src/"]);
  assert.deepEqual(receipt.verifiedEvidenceReferences, []);
  const state = h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-state-v1").at(-1).data;
  assert.equal(state.gardenUnits[0].status, "complete");
  assert.deepEqual(state.gardenUnits[0].unresolved, []);
});



test("Garden refuses duplicate requests while one compaction is queued", async () => {
  const h = harness();
  h.emit("session_start");
  await h.commands.get("rabbit")("mode garden", h.context);
  const tool = h.tools.get("rabbit_garden");
  const request = { decision: "compact", reason: "Preserve one mission checkpoint." };
  const first = await tool.execute("compact", request, undefined, undefined, h.context);
  const duplicate = await tool.execute("compact", request, undefined, undefined, h.context);
  assert.equal(first.terminate, true);
  assert.equal(duplicate.isError, true);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
});test("Garden compaction failure records a truthful failed receipt and clears the pending request", async () => {
  const h = harness();
  h.emit("session_start");
  await h.commands.get("rabbit")("mode garden", h.context);
  const tool = h.tools.get("rabbit_garden");
  const scheduled = await tool.execute("compact", { decision: "compact", reason: "Keep the current mission state compact." }, undefined, undefined, h.context);
  assert.equal(scheduled.terminate, true);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.compactCalls[0].onError(new Error("native compaction rejected"));
  const state = h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-state-v1").at(-1).data;
  assert.equal(state.pendingGardenRequest, undefined);
  assert.equal(state.lastGardenReceipt.status, "failed");
  assert.match(state.lastGardenReceipt.reason, /rejected/);
});

test("Garden in-flight compaction is recorded as interrupted after session restart", async () => {
  const h = harness();
  h.emit("session_start");
  await h.commands.get("rabbit")("mode garden", h.context);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("compact", { decision: "compact", reason: "Preserve the active mission checkpoint." }, undefined, undefined, h.context);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.emit("session_shutdown");
  h.emit("session_start");
  const state = h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-state-v1").at(-1).data;
  assert.equal(state.pendingGardenRequest, undefined);
  assert.equal(state.lastGardenReceipt.status, "interrupted");
  assert.match(state.lastGardenReceipt.reason, /restart/);
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 10_000 });
  assert.equal(h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-receipt-v1").length, 0, "stale completion from the old session is ignored");
});
test("Garden restores exact Pi evidence beyond summary truncation without rewriting history", async () => {
  const h = harness();
  const fullEvidence = `${"x".repeat(2_500)}EXACT_SOURCE_TAIL`;
  const sourceEntry = {
    type: "message",
    id: "source-evidence-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "toolResult", content: [{ type: "text", text: fullEvidence }] },
  };
  h.entries.push(sourceEntry);
  h.emit("session_start");
  await h.commands.get("rabbit")("mode garden", h.context);
  const tool = h.tools.get("rabbit_garden");
  const restored = await tool.execute("restore", {
    decision: "restore",
    evidenceReferences: ["pi-entry:source-evidence-1"],
  }, undefined, undefined, h.context);
  assert.ok(restored.content[0].text.length > 2_000);
  assert.ok(restored.content[0].text.includes(fullEvidence));
  assert.equal(h.entries.includes(sourceEntry), true);
  assert.equal(h.entries.filter((entry) => entry.customType === "rabbit-pi-compactor-garden-receipt-v1").at(-1).data.status, "restored");
});
