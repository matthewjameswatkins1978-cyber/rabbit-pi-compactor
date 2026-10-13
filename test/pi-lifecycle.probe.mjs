/**
 * Real Pi SDK lifecycle probe (isolated, disposable, no credentials).
 *
 * Drives the BUILT Rabbit extension through Pi 1.1.0's REAL extension
 * loader (loadExtensionFromFactory), REAL event bus emission
 * (ExtensionRunner.emit: session_start / turn_end / session_shutdown),
 * REAL tool-context creation, and REAL SessionManager persistence in a
 * temp dir. The only stubbed boundary is Pi's native compact execution
 * itself (compactFn), which in production requires model access + API
 * credentials that this mission forbids. That boundary is reported, not
 * mocked over: dispatch scheduling/termination/receipts/restore are real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
// loadExtensionFromFactory is not re-exported from the Pi public index, so
// import the real loader module by file path (same package, no duplication).
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createRabbitExtension } from "../dist/index.js";

const step = (n) => console.log(`[lifecycle] ${n}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-lifecycle-"));
const sessionDir = path.join(tmp, "sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const compactCalls = [];
let usage = { tokens: 300_000, contextWindow: 1_000_000, percent: 30, quotaPercent: 0 };

function wire(sessionManager) {
  const eventBus = createEventBus();
  const runtime = createExtensionRuntime();
  return { eventBus, runtime };
}

const sm1 = SessionManager.create(tmp, sessionDir);
const { eventBus, runtime } = wire(sm1);
const ext = await loadExtensionFromFactory(createRabbitExtension(), tmp, eventBus, runtime, "rabbit-test");
const runner = new ExtensionRunner([ext], runtime, tmp, sm1, undefined);
runner.bindCore(
  {
    sendMessage: async () => {},
    sendUserMessage: async () => {},
    appendEntry: (customType, data) => sm1.appendCustomEntry(customType, data),
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    getSettings: () => ({}),
    setActiveTools: () => {},
    refreshTools: () => {},
    getCommands: () => [],
    setModel: async () => {},
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => {},
  },
  {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => ({ ...usage }),
    compact: (options) => compactCalls.push(options),
    getSystemPrompt: () => "",
    executeTool: undefined,
    getCallableTools: () => [],
  },
  {},
);

step(`1. isolated session in ${tmp}; extension loaded via real Pi loader`);
assert.ok(ext.tools.has("rabbit_garden"), "rabbit_garden registered through real Pi loader");
assert.ok(ext.commands.has("rabbit"), "/rabbit command registered through real Pi loader");

await runner.emit({ type: "session_start" });
step("2. real session_start emitted through Pi event bus");

const rabbitCommand = ext.commands.get("rabbit");
assert.ok(rabbitCommand, "/rabbit command handler registered");
const cmdCtx = runner.createCommandContext();
await rabbitCommand.handler("mode garden", cmdCtx);
step("2b. Garden mode enabled via the real registered /rabbit command");

const toolCtx = runner.createToolContext("call-1", undefined);
const garden = ext.tools.get("rabbit_garden");
const recordArgs = {
  decision: "record",
  unitId: "lifecycle-unit",
  summary: "Lifecycle probe work, accepted.",
  status: "complete",
  evidenceReferences: ["git:main@abc123:src/"],
  unresolved: [],
};
// Registered tool shape: { definition, execute } or direct execute; resolve defensively.
const toolEntry = garden;
const executeFn =
  typeof toolEntry.execute === "function"
    ? toolEntry.execute.bind(toolEntry)
    : typeof toolEntry.definition?.execute === "function"
      ? toolEntry.definition.execute.bind(toolEntry.definition)
      : null;
assert.ok(executeFn, "registered tool exposes an execute function");
const recorded = await executeFn("call-1", recordArgs, undefined, undefined, toolCtx);
assert.equal(recorded.isError, undefined, JSON.stringify(recorded));
step("3. real registered rabbit_garden tool executed: record (complete unit)");

const folded = await executeFn("call-2", { decision: "fold", unitId: "lifecycle-unit", reason: "Compact accepted context." }, undefined, undefined, toolCtx);
assert.equal(folded.terminate, true, "fold terminates the turn via the real tool contract");
assert.equal(compactCalls.length, 0, "scheduling only; no dispatch before turn_end");
step("4. fold requested: terminate observed, dispatch deferred to turn_end");

await runner.emit({ type: "turn_end" });
assert.equal(compactCalls.length, 1, "real turn_end dispatched the queued request");
assert.match(compactCalls[0].customInstructions, /lifecycle-unit/);
step("5. real turn_end dispatched native compaction request");

// Boundary: execute Pi's REAL compact module here would require model + apiKey
// (see compact() in Pi SDK: needs preparation, model, apiKey, ...). No
// credentials are used in this probe per mission rules, so the native
// summarisation step is the documented unverified boundary. Complete the
// scheduling contract the way Pi would on success:
compactCalls[0].onComplete({ estimatedTokensAfter: 22_000 });
step("6. onComplete delivered (native summarisation itself is the no-credentials boundary)");

const branch = sm1.getBranch();
const gardenReceipts = branch.filter((e) => e.type === "custom" && e.customType === "rabbit-pi-compactor-garden-receipt-v1");
const nativeReceipts = branch.filter((e) => e.type === "custom" && e.customType === "rabbit-pi-compactor-receipt-v1");
assert.ok(gardenReceipts.length >= 3, `expected scheduled/started/completed garden receipts, got ${gardenReceipts.length}`);
assert.equal(nativeReceipts.length, 1, "native compaction receipt recorded in real session history");
assert.equal(gardenReceipts.at(-1).data.status, "completed");
step(`7. real session history: ${gardenReceipts.length} garden receipts + 1 native receipt`);

// Exact native evidence round-trip through the real branch.
const nativeMsg = { role: "assistant", content: "EXACT_PROBE_EVIDENCE_TAIL" };
sm1.appendMessage(nativeMsg);
const probeEntry = sm1.getBranch().find((e) => JSON.stringify(e).includes("EXACT_PROBE_EVIDENCE_TAIL"));
assert.ok(probeEntry?.id, "native entry exists on the real branch");
const restored = await executeFn("call-3", { decision: "restore", evidenceReferences: [`pi-entry:${probeEntry.id}`] }, undefined, undefined, toolCtx);
assert.equal(restored.isError, undefined, JSON.stringify(restored));
assert.match(restored.content[0].text, /EXACT_PROBE_EVIDENCE_TAIL/);
step("8. exact native evidence entry restored from the real branch");

// Restart: reopen the SAME Pi session file with a fresh manager + runner.
await runner.emit({ type: "session_shutdown" });
const reopenedId = sm1.getSessionId();
const sm2 = SessionManager.open(sm1.getSessionFile(), sessionDir);
const sameId = sm1.getSessionId() === sm2.getSessionId();
const branch2 = sm2.getBranch();
const nativeStillThere = branch2.filter((e) => e.type === "custom" && e.customType === "rabbit-pi-compactor-receipt-v1").length;
console.log(`[lifecycle] 9. reopen: sameSessionId=${sameId} nativeReceiptsAfterReopen=${nativeStillThere} branchEntries=${branch2.length}`);
step("9. session reopened against the same isolated dir; history inspected above");

console.log("[lifecycle] PROBE COMPLETE");
console.log(`[lifecycle] tmp=${tmp}`);
