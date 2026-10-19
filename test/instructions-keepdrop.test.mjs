import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRabbitExtension, RABBIT_COMPACTION_INSTRUCTIONS } from "../dist/index.js";

// The keep/drop contract is applied automatically: Rabbit attaches these
// instructions to every Rabbit-requested native compaction with no user input.
test("compaction instructions name protected artifacts explicitly", () => {
  for (const required of [
    "Never drop:",
    "failing tests with exact error text",
    "reproduction steps",
    "never upgrade partial to complete",
    "Always drop first",
    "passing test logs",
    "already superseded by a later result",
    "Evidence rule:",
    "pi-entry:<id>",
    "reference format alone does not establish proof",
    "not an absolute guarantee",
    "never upgrade them to fact",
  ]) {
    assert.match(RABBIT_COMPACTION_INSTRUCTIONS, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("automatic auto-compaction carries the keep/drop contract with no user input", () => {
  process.env.RABBIT_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-keepdrop-")), "rabbit.json");
  const handlers = new Map();
  const entries = [];
  const compactCalls = [];
  const statuses = new Map();
  let tokens = 300_000;
  const context = {
    get hasUI() { return true; },
    get model() { return { provider: "meta", id: "muse-spark-1.3-contributor" }; },
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: (tokens / 1_000_000) * 100, quotaPercent: 0 }),
    get isIdle() { return () => true; },
    get sessionManager() { return { getSessionId: () => "session-1", getBranch: () => entries }; },
    compact: (options) => compactCalls.push(options),
    ui: { setStatus: (key, value) => statuses.set(key, value), notify: () => {} },
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    registerTool: () => {},
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    getSettings: () => ({}),
  };
  createRabbitExtension()(pi);
  handlers.get("session_start")({}, context);
  tokens = 800_000;
  handlers.get("turn_end")({}, context);
  assert.equal(compactCalls.length, 1);
  const instructions = String(compactCalls[0].customInstructions ?? "");
  assert.match(instructions, /Never drop:/);
  assert.match(instructions, /failing tests with exact error text/);
  assert.match(instructions, /Always drop first/);
  assert.match(instructions, /passing test logs/);
  assert.match(instructions, /Evidence rule:/);
});
