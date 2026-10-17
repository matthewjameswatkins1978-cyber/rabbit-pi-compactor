import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRabbitExtension, RECEIPT_ENTRY } from "../dist/index.js";

const GARDEN_STATE = "rabbit-pi-compactor-state-v1";
const GARDEN_RECEIPT = "rabbit-pi-compactor-garden-receipt-v1";
const TRACE_EXPORT = "rabbit-pi-compactor-trace-export-v1";

function harness(initialTokens = 300_000, contextWindow = 1_000_000) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  const compactCalls = [];
  const statuses = new Map();
  const notices = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-observe-test-"));
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
    compact: (options) => compactCalls.push(options),
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
  const emit = (event, ctx = context) => handlers.get(event)?.({}, ctx);
  const setUsage = (nextTokens, nextWindow = window) => { tokens = nextTokens; window = nextWindow; };
  const command = (args) => commands.get("rabbit")(args, context);
  const lastState = () => entries.filter((e) => e.customType === GARDEN_STATE).at(-1)?.data;
  const gardenReceipts = () => entries.filter((e) => e.customType === GARDEN_RECEIPT).map((e) => e.data);
  const traceExports = () => entries.filter((e) => e.customType === TRACE_EXPORT).map((e) => e.data);
  return { context, cwd, commands, command, compactCalls, emit, entries, notices, setUsage, tools, lastState, gardenReceipts, traceExports };
}

async function gardenMode(h) {
  h.emit("session_start");
  await h.command("mode garden");
}

test("/rabbit threshold leaving Garden invalidates the queued request", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  const scheduled = await tool.execute("compact", { decision: "compact", reason: "Queued before threshold." }, undefined, undefined, h.context);
  assert.equal(scheduled.terminate, true);
  await h.command("threshold 90");
  const state = h.lastState();
  assert.equal(state.mode, "manual");
  assert.equal(state.pendingGardenRequest, undefined);
  assert.equal(state.lastGardenReceipt.status, "cancelled");
  assert.match(state.lastGardenReceipt.reason, /leaving Garden/);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "threshold must never resurrect the abandoned Garden request");
});

test("Observe mode never compacts on pressure", async () => {
  const h = harness(340_000);
  h.emit("session_start");
  await h.command("mode observe");
  assert.equal(h.lastState().mode, "observe");
  // Far above the 88% auto trigger on the effective budget.
  h.setUsage(970_000);
  h.emit("turn_end");
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
  assert.equal(h.entries.filter((e) => e.customType === RECEIPT_ENTRY).length, 0);
  assert.equal(h.lastState().pendingGardenRequest, undefined);
});

test("Observe mode rejects garden fold/compact but allows record/status", async () => {
  const h = harness();
  h.emit("session_start");
  await h.command("mode observe");
  const tool = h.tools.get("rabbit_garden");
  const fold = await tool.execute("fold", { decision: "fold", unitId: "u1", reason: "Must be refused." }, undefined, undefined, h.context);
  assert.equal(fold.isError, true);
  assert.match(fold.content[0].text, /Observe mode/);
  const compact = await tool.execute("compact", { decision: "compact", reason: "Must be refused." }, undefined, undefined, h.context);
  assert.equal(compact.isError, true);
  const recorded = await tool.execute("record", {
    decision: "record", unitId: "u1", summary: "Observed work.",
    evidenceReferences: ["git:main@abc:src/"], unresolved: ["Later."],
  }, undefined, undefined, h.context);
  assert.equal(recorded.isError, undefined);
  const status = await tool.execute("status", { decision: "status" }, undefined, undefined, h.context);
  assert.equal(status.isError, undefined);
  assert.equal(h.compactCalls.length, 0);
});

test("Observe mode refuses /rabbit compact", async () => {
  const h = harness();
  h.emit("session_start");
  await h.command("mode observe");
  await h.command("compact");
  assert.equal(h.compactCalls.length, 0);
  assert.ok(h.notices.some((n) => n.includes("Observe mode never requests compaction")));
});

test("Garden -> observe invalidates the queued request", async () => {
  const h = harness();
  await gardenMode(h);
  const tool = h.tools.get("rabbit_garden");
  await tool.execute("compact", { decision: "compact", reason: "Queued before observe." }, undefined, undefined, h.context);
  await h.command("mode observe");
  const state = h.lastState();
  assert.equal(state.pendingGardenRequest, undefined);
  assert.equal(state.lastGardenReceipt.status, "cancelled");
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0);
});

test("/rabbit doctor reports sanitised observed/estimated/inferred/missing sections", async () => {
  const h = harness();
  h.emit("session_start");
  await h.command("mode observe");
  await h.command("doctor");
  const output = h.notices.at(-1);
  assert.match(output, /RABBIT DOCTOR/);
  const payload = JSON.parse(output.slice(output.indexOf("\n") + 1));
  assert.equal(payload.rabbit, "0.2.3");
  assert.equal(payload.observed.mode, "observe");
  for (const section of ["observed", "estimated", "inferred", "missing", "safety"]) {
    assert.ok(payload[section] !== undefined, `doctor section ${section} present`);
  }
  assert.ok(Array.isArray(payload.safety) && payload.safety.length > 0);
  assert.ok(!/api[_-]?key|secret|credential|prompt/i.test(output), "doctor output carries no secrets or prompts");
});

test("/rabbit trace captures pressure and exports a bounded sanitised report to a file", async () => {
  const h = harness();
  h.emit("session_start");
  await h.command("mode observe");
  await h.command("trace on");
  for (let i = 0; i < 250; i += 1) {
    h.setUsage(500_000 + i);
    h.emit("turn_end");
  }
  assert.equal(h.compactCalls.length, 0, "trace capture must not change native behaviour");
  const file = "lucy-trace-report.json";
  await h.command(`trace export ${file}`);
  const exported = h.traceExports().at(-1);
  assert.ok(exported, "export persists a bounded session entry");
  assert.ok(exported.events.length <= 50, "persisted export entry is bounded");
  const onDisk = JSON.parse(fs.readFileSync(path.join(h.cwd, file), "utf8"));
  assert.equal(onDisk.rabbit, "0.2.3");
  assert.equal(onDisk.eventCount, 200, "in-memory ring is capped at 200 events");
  assert.equal(onDisk.events.length, 200);
  assert.ok(onDisk.events.every((e) => e.kind && e.detail && e.seq > 0));
  const blob = JSON.stringify(onDisk);
  assert.ok(!/api[_-]?key|secret|credential/i.test(blob), "trace report carries no secrets");
  assert.ok(!blob.includes("500_000"), "trace holds metadata, not conversation content");
  await h.command("trace off");
  const before = h.notices.length;
  h.emit("turn_end");
  assert.equal(h.notices.length, before, "trace off captures nothing further");
});
