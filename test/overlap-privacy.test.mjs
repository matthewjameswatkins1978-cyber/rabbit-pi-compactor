import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyFailure, createRabbitExtension, RECEIPT_ENTRY } from "../dist/index.js";

const GARDEN_STATE = "rabbit-pi-compactor-state-v1";
const GARDEN_RECEIPT = "rabbit-pi-compactor-garden-receipt-v1";
const TRACE_EXPORT = "rabbit-pi-compactor-trace-export-v1";

function harness(initialTokens = 300_000, contextWindow = 1_000_000, opts = {}) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const compactCalls = [];
  const statuses = new Map();
  const notices = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-overlap-test-"));
  let sessionId = "session-1";
  let tokens = initialTokens;
  let window = contextWindow;
  const context = {
    get hasUI() { return true; },
    get cwd() { return cwd; },
    get model() { return { provider: "meta", id: "muse-spark-1.3-contributor" }; },
    getContextUsage: () => ({ tokens, contextWindow: window, percent: (tokens / window) * 100, quotaPercent: 0 }),
    get isIdle() { return () => true; },
    get sessionManager() { return { getSessionId: () => sessionId, getBranch: () => entries }; },
    compact: (options) => {
      if (opts.throwOnCompact) throw new Error(opts.throwOnCompact);
      compactCalls.push(options);
    },
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: (message) => notices.push(String(message)),
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
  const emit = (event, payload = {}, ctx = context) => handlers.get(event)?.(payload, ctx);
  const setUsage = (nextTokens, nextWindow = window) => { tokens = nextTokens; window = nextWindow; };
  const command = (args) => commands.get("rabbit")(args, context);
  const lastState = () => entries.filter((e) => e.customType === GARDEN_STATE).at(-1)?.data;
  const gardenReceipts = () => entries.filter((e) => e.customType === GARDEN_RECEIPT).map((e) => e.data);
  const nativeReceipts = () => entries.filter((e) => e.customType === RECEIPT_ENTRY).map((e) => e.data);
  const traceExports = () => entries.filter((e) => e.customType === TRACE_EXPORT).map((e) => e.data);
  const scanAll = () => JSON.stringify(entries) + "\n" + notices.join("\n");
  return { context, cwd, compactCalls, emit, entries, notices, setUsage, tools, command, lastState, gardenReceipts, nativeReceipts, traceExports, scanAll };
}

async function gardenMode(h) {
  h.emit("session_start");
  await h.command("mode garden");
}

async function recordComplete(h, unitId = "u1") {
  const tool = h.tools.get("rabbit_garden");
  const recorded = await tool.execute("record", {
    decision: "record", unitId, summary: "Accepted work.",
    status: "complete", evidenceReferences: ["git:main@abc:src/"], unresolved: [],
  }, undefined, undefined, h.context);
  assert.equal(recorded.isError, undefined, JSON.stringify(recorded));
}

async function rearm(h, low = 100_000) {
  h.setUsage(low);
  h.emit("turn_end");
}

test("in-flight Garden -> mode switch -> new attempt blocked until old callback; stale writes nothing", async () => {
  const h = harness();
  await gardenMode(h);
  await recordComplete(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("fold", { decision: "fold", unitId: "u1", reason: "Fold it." }, undefined, undefined, h.context);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "fold dispatched once");
  await h.command("mode auto");
  assert.equal(h.lastState().lastGardenReceipt.status, "interrupted");
  assert.equal(h.lastState().pendingGardenRequest, undefined);
  // Rearm so the threshold path genuinely attempts a new dispatch.
  await rearm(h);
  h.setUsage(970_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "physical guard blocks a second native call while the first runs");
  // Stale callback for the abandoned generation: releases the guard, writes nothing.
  const gardenBefore = h.gardenReceipts().length;
  const nativeBefore = h.nativeReceipts().length;
  h.compactCalls[0].onComplete({ estimatedTokensAfter: 20_000 });
  assert.equal(h.compactCalls.length, 1);
  assert.equal(h.gardenReceipts().length, gardenBefore, "stale onComplete writes no garden receipt");
  assert.equal(h.nativeReceipts().length, nativeBefore, "stale onComplete writes no native receipt");
  // Guard released: a fresh crossing dispatches exactly once more.
  await rearm(h);
  h.setUsage(970_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2, "guard releases after terminal acknowledgment");
  h.compactCalls[1].onComplete({ estimatedTokensAfter: 21_000 });
  assert.equal(h.nativeReceipts().at(-1)?.trigger, "auto");
});

test("threshold switch during in-flight retains the guard and refuses manual compaction", async () => {
  const h = harness();
  await gardenMode(h);
  await recordComplete(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("compact", { decision: "compact", reason: "Checkpoint." }, undefined, undefined, h.context);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  await h.command("threshold 90");
  assert.equal(h.lastState().mode, "manual");
  assert.equal(h.lastState().lastGardenReceipt.status, "interrupted");
  await h.command("compact");
  assert.equal(h.compactCalls.length, 1, "manual refused while a native op is unacknowledged");
  assert.ok(h.notices.some((n) => n.includes("already running")), JSON.stringify(h.notices));
  await rearm(h);
  h.setUsage(970_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "threshold path also blocked while the first op runs");
  // Stale failure clears the guard without receipts, then a fresh crossing dispatches.
  const gardenBefore = h.gardenReceipts().length;
  h.compactCalls[0].onError(new Error("native fold rejected"));
  assert.equal(h.gardenReceipts().length, gardenBefore, "stale onError writes no receipt");
  await rearm(h);
  h.setUsage(970_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2);
});

test("observed external native op blocks Rabbit dispatch until its terminal event", async () => {
  const h = harness();
  h.emit("session_start");
  await h.command("trace on");
  h.emit("session_before_compact", { reason: "threshold", willRetry: false });
  h.setUsage(970_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "Rabbit defers while any native compaction is observed");
  h.emit("session_compact_failed", { reason: "overflow", aborted: false, errorMessage: "simulated overflow failure", fromExtension: false, willRetry: false });
  await rearm(h);
  h.setUsage(970_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "terminal event releases the observed-op guard");
});

test("secret canary never leaks through failures, doctor, status, or trace", async () => {
  const CAN = "sk-live-canary-9f8x7q2";
  const evil = (tag) => `provider blew up ${CAN}-${tag} at /home/user/secret-proj key=password-hunter2-${tag}`;
  const h = harness();
  h.emit("session_start");
  await h.command("trace on");
  // Auto onError with a hostile message.
  h.setUsage(340_000);
  h.emit("turn_end"); // below trigger; nothing dispatched yet
  h.setUsage(970_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  h.compactCalls[0].onError(new Error(evil("auto")));
  // External failure notification with a hostile message.
  h.emit("session_compact_failed", { reason: "threshold", aborted: false, errorMessage: evil("event"), fromExtension: false, willRetry: false });
  // Garden failure with a hostile message.
  await h.command("mode garden");
  await recordComplete(h, "u9");
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("fold", { decision: "fold", unitId: "u9", reason: "Fold with hostile native." }, undefined, undefined, h.context);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 2);
  h.compactCalls[1].onError(new Error(evil("garden")));
  await h.command("doctor");
  await h.command("status");
  await h.command("trace export");
  const blob = h.scanAll();
  for (const needle of [CAN, "hunter2", "secret-proj"]) {
    assert.ok(!blob.includes(needle), `diagnostics leak ${needle}`);
  }
  assert.match(blob, /\[compaction-failed\]/, "stable failure code reported instead");
  const failed = h.gardenReceipts().find((r) => r.status === "failed");
  assert.equal(failed?.reason, "compaction-failed");
});

test("synchronous compact throw is classified and never leaks", async () => {
  const h = harness(340_000, 1_000_000, { throwOnCompact: "sync boom sk-live-canary-sync at /tmp/x" });
  h.emit("session_start");
  h.setUsage(970_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
  assert.equal(h.lastState().lastError, "compaction-failed");
  assert.ok(!h.scanAll().includes("canary"));
});

test("trace export never overwrites and never escapes the working directory", async () => {
  const h = harness();
  h.emit("session_start");
  await h.command("trace on");
  await h.command("mode garden");
  const target = path.join(h.cwd, "r.json");
  await h.command("trace export r.json");
  assert.ok(fs.existsSync(target), "first export writes");
  const first = fs.readFileSync(target, "utf8");
  assert.ok(JSON.parse(first).events.length >= 1);
  await h.command("trace export r.json");
  assert.equal(fs.readFileSync(target, "utf8"), first, "second export refuses to clobber");
  assert.ok(h.notices.some((n) => n.includes("already exists")), JSON.stringify(h.notices));
  const escape = path.join(path.dirname(h.cwd), `escape-${Date.now()}.json`);
  await h.command(`trace export ../${path.basename(escape)}`);
  assert.ok(!fs.existsSync(escape), "parent traversal refused");
  assert.ok(h.notices.some((n) => n.includes("inside the Pi working directory")), JSON.stringify(h.notices));
  const abs = path.join(os.tmpdir(), `rab-abs-${Date.now()}.json`);
  await h.command(`trace export ${abs}`);
  assert.ok(!fs.existsSync(abs), "absolute path refused");
});

test("classifyFailure maps known failures and passes codes through", () => {
  assert.equal(classifyFailure(new Error("Nothing to compact (session too small)")), "session-too-small");
  assert.equal(classifyFailure(new Error("Compaction failed: Nothing to compact (session too small)")), "session-too-small");
  assert.equal(classifyFailure(new Error("Compaction failed: Already compacted")), "already-compacted");
  assert.equal(classifyFailure(new Error("Compaction cancelled by user")), "compaction-cancelled");
  assert.equal(classifyFailure(new Error("Pi native compaction is unavailable.")), "native-unavailable");
  assert.equal(classifyFailure(new Error("weird provider explosion sk-abc")), "compaction-failed");
  assert.equal(classifyFailure("session-too-small"), "session-too-small");
  assert.equal(classifyFailure("compaction-failed"), "compaction-failed");
  assert.equal(classifyFailure(undefined), "compaction-failed");
});
