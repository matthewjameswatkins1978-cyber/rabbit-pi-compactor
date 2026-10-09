import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const GARDEN_RECEIPT_ENTRY = "rabbit-pi-compactor-garden-receipt-v1";
export const MAX_GARDEN_UNITS = 24;
export const MAX_GARDEN_STATE_CHARS = 48_000;
export const MAX_GARDEN_REFERENCES = 24;
export const MAX_RESTORED_EVIDENCE_CHARS = 48_000;

export type GardenDecision = "defer" | "fold" | "compact" | "restore" | "record" | "status";
export type GardenUnitStatus = "active" | "deferred" | "complete";

export interface GardenUnit {
  readonly id: string;
  readonly summary: string;
  readonly status: GardenUnitStatus;
  readonly evidenceReferences: readonly string[];
  readonly unresolved: readonly string[];
  readonly updatedAt: string;
}

export interface GardenRequest {
  readonly requestId: string;
  readonly decision: "fold" | "compact";
  readonly unitId?: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly status: "queued" | "in-flight";
}

export interface GardenReceipt {
  readonly version: 1;
  readonly decision: GardenDecision;
  readonly status: "recorded" | "deferred" | "scheduled" | "started" | "completed" | "failed" | "restored";
  readonly unitId?: string;
  readonly evidenceReferences?: readonly string[];
  readonly unresolvedCount?: number;
  readonly reason?: string;
  readonly timestamp: string;
}

export interface GardenToolInput {
  readonly decision: GardenDecision;
  readonly unitId?: string;
  readonly summary?: string;
  readonly status?: GardenUnitStatus;
  readonly evidenceReferences?: readonly string[];
  readonly unresolved?: readonly string[];
  readonly reason?: string;
}

export function validateGardenToolInput(value: unknown): GardenToolInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Garden decision must be an object.");
  }
  const input = value as Record<string, unknown>;
  const decisions: readonly GardenDecision[] = ["defer", "fold", "compact", "restore", "record", "status"];
  if (typeof input.decision !== "string" || !decisions.includes(input.decision as GardenDecision)) {
    throw new Error("Choose one Garden decision: status, record, defer, fold, compact, or restore.");
  }
  const text = (key: string, max: number, required = false): string | undefined => {
    const raw = input[key];
    if (raw === undefined && !required) return undefined;
    if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > max || raw !== raw.trim()) {
      throw new Error(`${key} must be a non-empty trimmed string of at most ${max} characters.`);
    }
    return raw;
  };
  const list = (key: string, maxItems: number, maxItemLength: number): readonly string[] | undefined => {
    const raw = input[key];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.length > maxItems) {
      throw new Error(`${key} must contain at most ${maxItems} items.`);
    }
    const values = raw.map((item) => {
      if (typeof item !== "string" || item.length === 0 || item.length > maxItemLength || item !== item.trim()) {
        throw new Error(`${key} entries must be non-empty trimmed strings of at most ${maxItemLength} characters.`);
      }
      return item;
    });
    if (new Set(values).size !== values.length) throw new Error(`${key} entries must be unique.`);
    return values;
  };
  const unitId = text("unitId", 128, input.decision === "record" || input.decision === "defer" || input.decision === "fold");
  const summary = text("summary", 512, input.decision === "record");
  const reason = text("reason", 512, input.decision === "defer" || input.decision === "fold" || input.decision === "compact");
  const status = input.status;
  if (status !== undefined && status !== "active" && status !== "deferred" && status !== "complete") {
    throw new Error("status must be active, deferred, or complete.");
  }
  const evidenceReferences = list("evidenceReferences", MAX_GARDEN_REFERENCES, 512);
  const unresolved = list("unresolved", 24, 512);
  if (input.decision === "restore" && (!evidenceReferences || evidenceReferences.length === 0)) {
    throw new Error("restore requires one or more exact evidenceReferences.");
  }
  if (input.decision === "record" && !evidenceReferences?.length && !unresolved?.length) {
    throw new Error("record requires evidenceReferences or unresolved state.");
  }
  return {
    decision: input.decision as GardenDecision,
    ...(unitId ? { unitId } : {}),
    ...(summary ? { summary } : {}),
    ...(status ? { status } : {}),
    ...(evidenceReferences ? { evidenceReferences } : {}),
    ...(unresolved ? { unresolved } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function restoreGardenEvidence(
  branch: readonly SessionEntry[],
  references: readonly string[],
): string {
  const entries = new Map(branch.map((entry) => [entry.id, entry]));
  const restored = references.map((reference) => {
    if (!reference.startsWith("pi-entry:") || reference.length <= "pi-entry:".length) {
      throw new Error(`Unsupported restore reference ${JSON.stringify(reference)}; use exact pi-entry:<entryId> references.`);
    }
    const entryId = reference.slice("pi-entry:".length);
    const entry = entries.get(entryId);
    if (!entry) throw new Error(`Evidence entry ${JSON.stringify(entryId)} is not on the active session branch.`);
    return { reference, entry };
  });
  const output = JSON.stringify({ status: "restored", evidence: restored }, null, 2);
  if (output.length > MAX_RESTORED_EVIDENCE_CHARS) {
    throw new Error(`Restore output exceeds ${MAX_RESTORED_EVIDENCE_CHARS} characters; request fewer evidence references. Source history is unchanged.`);
  }
  return output;
}