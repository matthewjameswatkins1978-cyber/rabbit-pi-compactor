import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRabbitExtension,
  decideSmartAuto,
  RECEIPT_ENTRY,
  SMART_AUTO_HIGH_PRESSURE_PERCENT,
  SMART_AUTO_PRESSURE_FLOOR_PERCENT,
} from "../dist/index.js";

const BUDGET = 1_000_000 - 16_384;

function harness(initialTokens = 300_000, contextWindow = 1_000_000, ui = {}) {
  // Isolate the durable file config per harness: never touch the real user config.
  process.env.RABBIT_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-030-")), "rabbit.json");
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
  let settings = {};
  let mode = ui.mode ?? "tui";
  let hasUI = ui.hasUI ?? true;
  const script = ui.script ?? [];
  const context = {
    get hasUI() { return hasUI; },
    get mode() { return mode; },
    get model() { return { provider: "meta", id: "muse-spark-1.3-contributor" }; },
    getContextUsage: () => ({ tokens, contextWindow: window, percent: tokens === null ? null : (tokens / window) * 100, quotaPercent: 0 }),
    get isIdle() { return () => true; },
    get sessionManager() { return { getSessionId: () => sessionId, getBranch: () => entries }; },
    compact: (options) => compactCalls.push(options),
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-030-cwd-")),
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: (message) => notices.push(String(message)),
      select: async (title, options) => {
        const next = script.shift();
        if (next === undefined) return undefined;
        if (typeof next === "number") return options[next];
        if (typeof next === "function") return next(title, options);
        return next;
      },
      input: async () => script.shift(),
      confirm: async () => script.shift() ?? false,
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
  return {
    context, commands, compactCalls, emit, entries, notices, statuses,
    setUsage: (nextTokens, nextWindow = window) => { tokens = nextTokens; window = nextWindow; },
    setSettings: (next) => { settings = next; },
    setMode: (nextMode, nextHasUI = true) => { mode = nextMode; hasUI = nextHasUI; },
    readFile: () => JSON.parse(fs.readFileSync(process.env.RABBIT_CONFIG_PATH, "utf8")),
    fileExists: () => fs.existsSync(process.env.RABBIT_CONFIG_PATH),
  };
}

// --- Smart Auto decision matrix (pure policy, no extension needed) ---

test("smart auto waits below its pressure floor", () => {
  const decision = decideSmartAuto({ percent: 45, tokens: 450_000, effectiveBudget: BUDGET, growthPercentPerTurn: 5, keepRecentTokens: 20_000 });
  assert.equal(decision.shouldCompact, false);
  assert.match(decision.reason, /below Smart Auto floor/);
});

test("smart auto never triggers without a measurement", () => {
  const decision = decideSmartAuto({ percent: NaN, tokens: 0, effectiveBudget: BUDGET, growthPercentPerTurn: undefined, keepRecentTokens: undefined });
  assert.equal(decision.shouldCompact, false);
  assert.match(decision.reason, /unknown/);
});

test("smart auto without known retention uses the high-pressure fallback openly", () => {
  const fire = decideSmartAuto({ percent: 80, tokens: 800_000, effectiveBudget: BUDGET, growthPercentPerTurn: 0, keepRecentTokens: undefined });
  assert.equal(fire.shouldCompact, true);
  assert.match(fire.reason, /fallback/);
  const wait = decideSmartAuto({ percent: 65, tokens: 650_000, effectiveBudget: BUDGET, growthPercentPerTurn: 9, keepRecentTokens: undefined });
  assert.equal(wait.shouldCompact, false);
  assert.match(wait.reason, /retention unknown/);
});

test("smart auto refuses trifling savings and fires on worthwhile savings with growth", () => {
  const refuse = decideSmartAuto({ percent: 62, tokens: 620_000, effectiveBudget: BUDGET, growthPercentPerTurn: 0.5, keepRecentTokens: 600_000 });
  assert.equal(refuse.shouldCompact, false);
  assert.match(refuse.reason, /savings/);
  const fire = decideSmartAuto({ percent: 70, tokens: 700_000, effectiveBudget: BUDGET, growthPercentPerTurn: 3, keepRecentTokens: 20_000 });
  assert.equal(fire.shouldCompact, true);
  assert.match(fire.reason, /growth/);
  const calm = decideSmartAuto({ percent: 70, tokens: 700_000, effectiveBudget: BUDGET, growthPercentPerTurn: 0.5, keepRecentTokens: 20_000 });
  assert.equal(calm.shouldCompact, false);
  assert.match(calm.reason, /growth/);
  const high = decideSmartAuto({ percent: 85, tokens: 850_000, effectiveBudget: BUDGET, growthPercentPerTurn: 0, keepRecentTokens: 20_000 });
  assert.equal(high.shouldCompact, true);
});

test("smart auto edges: floor is inclusive, 40% means nothing to it", () => {
  assert.equal(decideSmartAuto({ percent: SMART_AUTO_PRESSURE_FLOOR_PERCENT, tokens: 600_000, effectiveBudget: BUDGET, growthPercentPerTurn: 0, keepRecentTokens: undefined }).shouldCompact, false);
  assert.equal(decideSmartAuto({ percent: SMART_AUTO_HIGH_PRESSURE_PERCENT, tokens: 750_000, effectiveBudget: BUDGET, growthPercentPerTurn: 0, keepRecentTokens: undefined }).shouldCompact, true);
  const forty = decideSmartAuto({ percent: 40, tokens: 400_000, effectiveBudget: BUDGET, growthPercentPerTurn: 10, keepRecentTokens: 20_000 });
  assert.equal(forty.shouldCompact, false, "40% is a Fixed Threshold example, not a Smart Auto signal");
});

// --- Fixed Threshold behaviour ---

test("fixed threshold at 40% waits below, fires above, and fires when already above", () => {
  const h = harness(100_000);
  h.emit("session_start");
  h.commands.get("rabbit")("mode fixed", h.context);
  assert.match(h.notices.at(-1), /Fixed Threshold.*40%/);
  h.setUsage(300_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "30% is below the fixed 40%");
  h.setUsage(400_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "fires once the fixed percentage is reached");
  // A session that starts already above the threshold compacts at the first boundary.
  const g = harness(900_000);
  g.emit("session_start");
  g.commands.get("rabbit")("threshold 40", g.context);
  g.emit("turn_end");
  assert.equal(g.compactCalls.length, 1, "already above the fixed threshold still compacts");
});

// --- Persistence across sessions and restarts ---

test("settings persist to the file and survive restart", () => {
  const h = harness(100_000);
  h.emit("session_start");
  assert.equal(h.fileExists(), true, "first start migrates session state to the file");
  h.commands.get("rabbit")("mode fixed", h.context);
  h.commands.get("rabbit")("preserve continuity", h.context);
  assert.equal(h.readFile().mode, "manual");
  assert.equal(h.readFile().fixedThresholdPercent, 40);
  assert.equal(h.readFile().preservation, "continuity");
  h.emit("session_shutdown");
  h.emit("session_start");
  h.commands.get("rabbit")("status", h.context);
  assert.match(h.notices.at(-1), /Fixed Threshold/);
  assert.match(h.notices.at(-1), /Continuity/);
});

test("migration seeds the file from a 0.2.3 session threshold once", () => {
  const h = harness(100_000);
  h.entries.push({
    type: "custom",
    customType: "rabbit-pi-compactor-state-v1",
    data: {
      kind: "rabbit-state",
      mode: "manual",
      config: { thresholdOverride: 90, hysteresisPercent: 5, customInstructions: "" },
      armed: true,
    },
  });
  assert.equal(h.fileExists(), false);
  h.emit("session_start");
  assert.equal(h.fileExists(), true);
  assert.equal(h.readFile().mode, "manual");
  assert.equal(h.readFile().fixedThresholdPercent, 90, "legacy 90% manual threshold is honoured, not reset");
});

// --- Menu navigation and cancellation ---

test("a corrupt config file never overrides live session state and is repaired", () => {
  const h = harness(100_000);
  fs.writeFileSync(process.env.RABBIT_CONFIG_PATH, "{not valid json");
  h.entries.push({
    type: "custom",
    customType: "rabbit-pi-compactor-state-v1",
    data: { kind: "rabbit-state", mode: "manual", config: { thresholdOverride: 75, hysteresisPercent: 5, customInstructions: "" }, armed: true },
  });
  h.emit("session_start");
  h.setUsage(800_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "live manual/75 survives the corrupt file");
  assert.equal(h.readFile().mode, "manual");
  assert.equal(h.readFile().fixedThresholdPercent, 75, "repair preserves the live threshold, not defaults");
});

test("menu changes preservation through keyboard selection", async () => {
  const h = harness(100_000, 1_000_000, { script: [2, 1, 6] });
  h.emit("session_start");
  await h.commands.get("rabbit")("", h.context);
  assert.ok(h.notices.some((n) => n.includes("Project Continuity")), "menu confirms the new preset");
  assert.equal(h.readFile().preservation, "continuity");
});

test("menu cancellation changes nothing", async () => {
  const h = harness(100_000, 1_000_000, { script: [undefined] });
  h.emit("session_start");
  const before = h.readFile();
  await h.commands.get("rabbit")("", h.context);
  assert.deepEqual(h.readFile(), before);
  assert.equal(h.notices.length, 0);
});

test("menu rejects an invalid custom threshold without changing settings", async () => {
  const h = harness(100_000, 1_000_000, { script: [1, 1, 5, "abc", undefined, 6] });
  h.emit("session_start");
  await h.commands.get("rabbit")("", h.context);
  assert.ok(h.notices.some((n) => n.includes("1 to 99")), "menu explains the valid range");
  assert.equal(h.readFile().fixedThresholdPercent, 40);
  assert.equal(h.readFile().mode, "auto", "rejected input never flips the mode");
});

test("headless operation explains itself without terminal UI", async () => {
  const h = harness(100_000);
  h.setMode("print", false);
  h.emit("session_start");
  await h.commands.get("rabbit")("", h.context);
  assert.ok(h.notices.some((n) => n.includes("Headless mode")), "headless callers get text guidance");
  h.commands.get("rabbit")("mode smart", h.context);
  h.commands.get("rabbit")("threshold adaptive", h.context);
  assert.equal(h.readFile().mode, "auto", "text commands keep working without a terminal");
});

// --- Preservation presets change real behaviour ---

test("presets shape Rabbit-requested compaction instructions", () => {
  const h = harness(100_000);
  h.emit("session_start");
  h.commands.get("rabbit")("preserve technical", h.context);
  h.setUsage(800_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1);
  assert.match(h.compactCalls[0].customInstructions, /Technical/);
  assert.match(h.compactCalls[0].customInstructions, /reproduction steps/);
  const g = harness(100_000);
  g.emit("session_start");
  g.setUsage(800_000);
  g.emit("turn_end");
  assert.match(g.compactCalls[0].customInstructions, /Balanced/);
  assert.ok(!g.compactCalls[0].customInstructions.includes("Project Continuity"));
});

// --- Smart Auto integration: known retention, overlap, aliases ---

test("smart auto uses known retention for savings and growth", () => {
  const h = harness(590_000);
  h.setSettings({ compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 } });
  h.emit("session_start");
  h.setUsage(595_000);
  h.emit("turn_end");
  h.setUsage(600_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "61% with slow growth and known retention waits");
  h.setUsage(640_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "fast growth toward the mark compacts");
  assert.match(h.compactCalls[0].customInstructions, /Balanced/);
});

test("smart auto defers while native compaction runs and resumes after", () => {
  const h = harness(100_000);
  h.emit("session_start");
  h.setUsage(800_000);
  h.emit("session_before_compact");
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "never overlaps a running native compaction");
  // The native operation compacts and usage falls; Rabbit observes and disarms.
  h.setUsage(30_000);
  h.emit("session_compact");
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 0, "disarmed after an observed native compaction");
  // Usage climbs again past the Smart Auto mark: Rabbit resumes on its own.
  h.setUsage(800_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "resumes once usage recovers past the mark");
});

test("legacy mode names keep working as aliases", () => {
  const h = harness(100_000);
  h.emit("session_start");
  h.commands.get("rabbit")("mode smart-auto", h.context);
  assert.equal(h.readFile().mode, "auto");
  h.commands.get("rabbit")("mode manual", h.context);
  assert.equal(h.readFile().mode, "manual");
  assert.equal(h.readFile().fixedThresholdPercent, 40);
  h.commands.get("rabbit")("threshold 75", h.context);
  assert.equal(h.readFile().fixedThresholdPercent, 75);
  h.setUsage(760_000);
  h.emit("turn_end");
  assert.equal(h.compactCalls.length, 1, "fixed 75% fires above its mark");
});
