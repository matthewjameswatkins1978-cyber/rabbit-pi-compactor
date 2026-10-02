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
  const entries = [];
  const compactCalls = [];
  const statuses = new Map();
  let sessionId = "session-1";
  let tokens = initialTokens;
  let window = contextWindow;
  const context = {
    get hasUI() { return true; },
    getContextUsage: () => ({ tokens, contextWindow: window, percent: tokens === null ? null : (tokens / window) * 100 }),
    get isIdle() { return () => true; },
    get sessionManager() { return { getSessionId: () => sessionId, getBranch: () => entries.filter((e) => e.type === "custom") }; },
    compact: (options) => compactCalls.push(options),
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: () => {},
    },
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command.handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  createRabbitExtension()(pi);
  const emit = (event, ctx = context) => handlers.get(event)?.({}, ctx);
  const setUsage = (nextTokens, nextWindow = window) => { tokens = nextTokens; window = nextWindow; };
  const replaceSession = (next) => { sessionId = next; };
  return { context, commands, compactCalls, emit, entries, replaceSession, setUsage, statuses };
}

test("adaptive thresholds use capacity bands and interpolation", () => {
  assert.equal(resolvePolicy(65_536)?.targetPercent, 90);
  assert.equal(resolvePolicy(131_072)?.targetPercent, 90);
  assert.equal(resolvePolicy(196_608)?.targetPercent, 62.5);
  assert.equal(resolvePolicy(262_144)?.targetPercent, 35);
  assert.equal(resolvePolicy(1_000_000)?.targetPercent, 35);
  assert.equal(resolvePolicy(undefined), undefined);
});

test("configuration supports override and rejects unsafe values", () => {
  const config = validateConfig({ thresholdOverride: 42 });
  assert.equal(resolvePolicy(1_000_000, config)?.targetPercent, 42);
  assert.equal(resolvePolicy(1_000_000, validateConfig({ thresholdOverride: null }))?.targetPercent, 35);
  assert.throws(() => validateConfig({ thresholdOverride: 100 }));
  assert.throws(() => validateConfig({ smallWindowBoundary: 0 }));
});

test("threshold crossing compacts once, receipts the result, and rearms below hysteresis", () => {
  const h = harness(340_000);
  h.emit("session_start");
  h.setUsage(350_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "exact threshold is not above it");
  h.setUsage(351_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.setUsage(500_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "staying above must not repeat");
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 28_000 });
  const receipt = h.entries.find((entry) => entry.customType === RECEIPT_ENTRY)?.data;
  assert.equal(receipt.trigger, "adaptive-threshold");
  assert.equal(receipt.estimatedTokensAfter, 28_000);
  h.setUsage(290_000);
  h.emit("turn_end");
  h.setUsage(351_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2, "rearms below 30%, then requires a new crossing");
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
  h.setUsage(50_000, 65_536);
  h.emit("model_select");
  h.setUsage(59_100, 65_536);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
});

test("native compaction disarms and the manual command uses Pi compact", () => {
  const h = harness(351_000);
  h.emit("session_start");
  h.emit("session_compact");
  h.setUsage(400_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
  h.commands.get("rabbit")("compact", h.context);
  assert.equal(h.compactCalls.length, 1);
});

test("disable command prevents automatic compaction", () => {
  const h = harness(340_000);
  h.emit("session_start");
  h.commands.get("rabbit")("off", h.context);
  h.setUsage(351_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
  assert.match(h.statuses.get("rabbit-compactor"), /off/);
});

test("unavailable native compaction API fails safely", () => {
  const h = harness(340_000);
  h.emit("session_start");
  h.context.compact = undefined;
  h.setUsage(351_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
});

test("failed compaction stays disarmed until safe rearm", () => {
  const h = harness(340_000);
  h.emit("session_start");
  h.setUsage(351_000);
  h.emit("turn_end");
  h.compactCalls[0].onError(new Error("test failure"));
  h.setUsage(400_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.setUsage(290_000);
  h.emit("turn_end");
  h.setUsage(351_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2);
});

test("session shutdown invalidates callbacks from the old session", () => {
  const h = harness(340_000);
  h.emit("session_start");
  h.setUsage(351_000);
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
