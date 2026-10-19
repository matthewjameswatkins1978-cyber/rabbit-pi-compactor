import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRabbitExtension, RECEIPT_ENTRY } from "../dist/index.js";

const GARDEN_STATE = "rabbit-pi-compactor-state-v1";
const GARDEN_RECEIPT = "rabbit-pi-compactor-garden-receipt-v1";

function harness(initialTokens = 300_000, contextWindow = 1_000_000) {
  // Isolate the durable file config per harness: never touch the real user config.
  process.env.RABBIT_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-test-")), "rabbit.json");
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const compactCalls = [];
  const statuses = new Map();
  const notices = [];
  let sessionId = "session-1";
  let tokens = initialTokens;
  let window = contextWindow;
  const context = {
    get hasUI() { return true; },
    get model() { return { provider: "meta", id: "muse-spark-1.3-contributor" }; },
    getContextUsage: () => ({ tokens, contextWindow: window, percent: (tokens / window) * 100, quotaPercent: 0 }),
    get isIdle() { return () => true; },
    get sessionManager() { return { getSessionId: () => sessionId, getBranch: () => entries }; },
    compact: (options) => compactCalls.push(options),
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: (message) => notices.push(message),
    },
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command.handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    getSettings: () => ({}),
  };
  createRabbitExtension()(pi);
  const emit = (event, ctx = context) => handlers.get(event)?.({}, ctx);
  const setUsage = (nextTokens, nextWindow = window) => { tokens = nextTokens; window = nextWindow; };
  const replaceSession = (next) => { sessionId = next; };
  const lastState = () => entries.filter((e) => e.customType === GARDEN_STATE).at(-1)?.data;
  const gardenReceipts = () => entries.filter((e) => e.customType === GARDEN_RECEIPT).map((e) => e.data);
  return { context, commands, compactCalls, emit, entries, replaceSession, setUsage, tools, notices, lastState, gardenReceipts };
}

async function gardenMode(h) {
  h.emit("session_start");
  await h.commands.get("rabbit")("mode garden", h.context);
}

test("queued request is cancelled by restart and never dispatched", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  const scheduled = await tool.execute("compact", { decision: "compact", reason: "Checkpoint before restart." }, undefined, undefined, h.context);
  assert.equal(scheduled.terminate, true);
  assert.equal(h.compactCalls.length, 0);
  h.emit("session_shutdown");
  h.emit("session_start");
  const state = h.lastState();
  assert.equal(state.pendingGardenRequest, undefined);
  assert.equal(state.lastGardenReceipt.status, "cancelled");
  assert.match(state.lastGardenReceipt.reason, /restart/);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "cancelled queued request must never dispatch after restart");
});

test("queued request is cancelled by session-tree change", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("compact", { decision: "compact", reason: "Checkpoint before tree switch." }, undefined, undefined, h.context);
  h.emit("session_tree");
  const state = h.lastState();
  assert.equal(state.pendingGardenRequest, undefined);
  assert.equal(state.lastGardenReceipt.status, "cancelled");
  assert.match(state.lastGardenReceipt.reason, /tree/);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
});

test("Garden -> Auto -> Garden never resurrects an old request", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("compact", { decision: "compact", reason: "Stale request probe." }, undefined, undefined, h.context);
  await h.commands.get("rabbit")("mode auto", h.context);
  let state = h.lastState();
  assert.equal(state.pendingGardenRequest, undefined);
  assert.equal(state.lastGardenReceipt.status, "cancelled");
  assert.match(state.lastGardenReceipt.reason, /leaving Garden/);
  await h.commands.get("rabbit")("mode garden", h.context);
  state = h.lastState();
  assert.equal(state.pendingGardenRequest, undefined, "switching back must not resurrect the old request");
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
});

test("/rabbit cancel abandons a queued request with a truthful receipt", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("compact", { decision: "compact", reason: "Will be cancelled." }, undefined, undefined, h.context);
  await h.commands.get("rabbit")("cancel", h.context);
  const state = h.lastState();
  assert.equal(state.pendingGardenRequest, undefined);
  assert.equal(state.lastGardenReceipt.status, "cancelled");
  assert.match(state.lastGardenReceipt.reason, /cancel/);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
});

test("late onComplete and onError callbacks cannot corrupt the new session", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("compact", { decision: "compact", reason: "In-flight probe." }, undefined, undefined, h.context);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  const staleComplete = h.compactCalls[0].onComplete;
  const staleError = h.compactCalls[0].onError;
  h.emit("session_shutdown");
  h.replaceSession("session-2");
  h.emit("session_start");
  const receiptsBefore = h.gardenReceipts().length;
  staleComplete({ estimatedTokensAfter: 9_000 });
  staleError(new Error("late native failure"));
  assert.equal(h.gardenReceipts().length, receiptsBefore, "late callbacks must not append receipts to the new session");
  assert.equal(h.entries.filter((e) => e.customType === RECEIPT_ENTRY).length, 0);
  assert.equal(h.lastState().pendingGardenRequest, undefined);
});

test("duplicate terminal notifications produce a single terminal receipt", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("compact", { decision: "compact", reason: "Duplicate terminal probe." }, undefined, undefined, h.context);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.compactCalls[0].onError(new Error("first failure"));
  const countAfterFirst = h.gardenReceipts().length;
  h.compactCalls[0].onError(new Error("second failure"));
  h.emit("session_compact_failed", h.context);
  assert.equal(h.gardenReceipts().length, countAfterFirst, "repeated terminal notifications must not duplicate receipts");
});

test("record rejects complete while unresolved obligations remain", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  const rejected = await tool.execute("record", {
    decision: "record", unitId: "u1", summary: "Claim of completion.",
    status: "complete", evidenceReferences: ["git:main@abc:src/"], unresolved: ["Still open."],
  }, undefined, undefined, h.context);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /unresolved/);
});

test("fold rejects unresolved work and requires a pre-completed unit", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("record", {
    decision: "record", unitId: "open-work", summary: "Open work.",
    evidenceReferences: ["git:main@abc:src/"], unresolved: ["Do the thing."],
  }, undefined, undefined, h.context);
  const folded = await tool.execute("fold", {
    decision: "fold", unitId: "open-work", reason: "Attempt premature fold.",
  }, undefined, undefined, h.context);
  assert.equal(folded.isError, true);
  assert.match(folded.content[0].text, /Fold requires/);
  assert.equal(h.compactCalls.length, 0);
});

test("fold of an accepted completed unit compacts without changing completion", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("record", {
    decision: "record", unitId: "done", summary: "Accepted work.",
    status: "complete", evidenceReferences: ["git:main@abc:src/"], unresolved: [],
  }, undefined, undefined, h.context);
  const scheduled = await tool.execute("fold", {
    decision: "fold", unitId: "done", reason: "Compact accepted context.",
  }, undefined, undefined, h.context);
  assert.equal(scheduled.terminate, true);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 21_000 });
  const receipt = h.gardenReceipts().at(-1);
  assert.equal(receipt.decision, "fold");
  assert.equal(receipt.status, "completed");
  assert.equal(h.lastState().gardenUnits[0].status, "complete");
  assert.deepEqual(h.lastState().gardenUnits[0].unresolved, []);
});

test("failed fold compaction never produces a completed receipt", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("record", {
    decision: "record", unitId: "done2", summary: "Accepted work.",
    status: "complete", evidenceReferences: ["git:main@abc:src/"], unresolved: [],
  }, undefined, undefined, h.context);
  await tool.execute("fold", { decision: "fold", unitId: "done2", reason: "Fold that will fail." }, undefined, undefined, h.context);
  h.emit("turn_end");
  h.compactCalls[0].onError(new Error("native fold rejected"));
  const receipt = h.gardenReceipts().at(-1);
  assert.equal(receipt.status, "failed");
  assert.notEqual(receipt.status, "completed");
  assert.equal(h.entries.filter((e) => e.customType === RECEIPT_ENTRY).length, 0);
});

test("native pi-entry handles are validated; unknown handles rejected", async () => {
  const h = harness();
  const source = { type: "message", id: "real-entry-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: "proof" } };
  h.entries.push(source);
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  const ok = await tool.execute("record", {
    decision: "record", unitId: "ev1", summary: "With real evidence.",
    evidenceReferences: ["pi-entry:real-entry-1"], unresolved: ["Follow up."],
  }, undefined, undefined, h.context);
  assert.equal(ok.isError, undefined);
  const bad = await tool.execute("record", {
    decision: "record", unitId: "ev2", summary: "With missing evidence.",
    evidenceReferences: ["pi-entry:no-such-entry"], unresolved: ["Follow up."],
  }, undefined, undefined, h.context);
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not on the active session branch/);
  const malformed = await tool.execute("restore", {
    decision: "restore", evidenceReferences: ["pi-entry:"],
  }, undefined, undefined, h.context);
  assert.equal(malformed.isError, true);
});

test("external pointers are retained as unverified, never verified proof", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("record", {
    decision: "record", unitId: "ext", summary: "External claim.",
    evidenceReferences: ["git:main@a1b2c3d:packages/adapter.ts"], unresolved: ["Check upstream."],
  }, undefined, undefined, h.context);
  const status = await tool.execute("status", { decision: "status" }, undefined, undefined, h.context);
  const payload = JSON.parse(status.content[0].text);
  assert.deepEqual(payload.units[0].verifiedEvidenceReferences, []);
  assert.deepEqual(payload.units[0].unverifiedEvidenceReferences, ["git:main@a1b2c3d:packages/adapter.ts"]);
  assert.match(status.content[0].text, /unverified/i);
});

test("repeat compactions sequence correctly and restart preserves history", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  for (let i = 0; i < 2; i += 1) {
    const scheduled = await tool.execute("compact", { decision: "compact", reason: `Checkpoint ${i}.` }, undefined, undefined, h.context);
    assert.equal(scheduled.terminate, true);
    h.emit("turn_end");
    h.compactCalls.at(-1).onComplete({ estimatedTokensAfter: 20_000 + i });
  }
  assert.equal(h.entries.filter((e) => e.customType === RECEIPT_ENTRY).length, 2);
  assert.equal(h.entries.filter((e) => e.customType === RECEIPT_ENTRY).at(-1).data.compactionNumber, 2);
  h.emit("session_shutdown");
  h.emit("session_start");
  assert.equal(h.entries.filter((e) => e.customType === RECEIPT_ENTRY).length, 2, "completed history survives restart");
  assert.equal(h.lastState().pendingGardenRequest, undefined);
});
