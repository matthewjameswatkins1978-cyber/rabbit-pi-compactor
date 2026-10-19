import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateConfig } from "./policy.js";
import type { RabbitConfig, RabbitMode } from "./policy.js";

export const RABBIT_FILE_CONFIG_VERSION = 1;
export const RABBIT_GLOBAL_FILENAME = "rabbit.json";
export const DEFAULT_FIXED_THRESHOLD_PERCENT = 40;

export type PreservationPreset = "balanced" | "continuity" | "technical";

export interface RabbitFileConfig {
  readonly version: 1;
  readonly mode: RabbitMode;
  readonly fixedThresholdPercent: number;
  readonly preservation: PreservationPreset;
  readonly hysteresisPercent: number;
}

export const DEFAULT_FILE_CONFIG: RabbitFileConfig = {
  version: 1,
  mode: "auto",
  fixedThresholdPercent: DEFAULT_FIXED_THRESHOLD_PERCENT,
  preservation: "balanced",
  hysteresisPercent: 5,
};

export function globalConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", RABBIT_GLOBAL_FILENAME);
}

export function validateFileConfig(input: unknown): RabbitFileConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Rabbit configuration must be an object.");
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error("Unsupported Rabbit configuration version.");
  }
  const mode = raw.mode ?? DEFAULT_FILE_CONFIG.mode;
  if (mode !== "auto" && mode !== "manual" && mode !== "off" && mode !== "garden" && mode !== "observe") {
    throw new Error("Rabbit mode must be auto, manual, off, garden, or observe.");
  }
  const fixed: unknown = raw.fixedThresholdPercent ?? DEFAULT_FILE_CONFIG.fixedThresholdPercent;
  if (typeof fixed !== "number" || !Number.isSafeInteger(fixed) || fixed < 1 || fixed > 99) {
    throw new Error("fixedThresholdPercent must be a whole percentage from 1 to 99.");
  }
  const preservation = raw.preservation ?? DEFAULT_FILE_CONFIG.preservation;
  if (preservation !== "balanced" && preservation !== "continuity" && preservation !== "technical") {
    throw new Error("preservation must be balanced, continuity, or technical.");
  }
  const hysteresis = raw.hysteresisPercent ?? DEFAULT_FILE_CONFIG.hysteresisPercent;
  if (typeof hysteresis !== "number" || !Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis >= 100) {
    throw new Error("hysteresisPercent must be between 0 and 99.");
  }
  return { version: 1, mode, fixedThresholdPercent: fixed, preservation, hysteresisPercent: hysteresis };
}

export interface LoadedFileConfig {
  readonly config: RabbitFileConfig;
  readonly path: string;
  /** True only when a valid file was read. Missing or corrupt files report false, so live session state wins and repairs the file on the next persist. */
  readonly present: boolean;
}

export function loadFileConfig(configPath?: string): LoadedFileConfig {
  const resolved = configPath ?? globalConfigPath();
  try {
    const text = fs.readFileSync(resolved, "utf8");
    return { config: validateFileConfig(JSON.parse(text)), path: resolved, present: true };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: { ...DEFAULT_FILE_CONFIG }, path: resolved, present: false };
    }
    // Corrupt config never breaks startup and never overrides live state.
    return { config: { ...DEFAULT_FILE_CONFIG }, path: resolved, present: false };
  }
}

export function saveFileConfig(config: RabbitFileConfig, configPath?: string): string {
  const resolved = configPath ?? globalConfigPath();
  const validated = validateFileConfig(config);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, resolved);
  return resolved;
}

/** Merge the durable file config into the live session config shape. */
export function toSessionConfig(file: RabbitFileConfig): RabbitConfig {
  return validateConfig({
    thresholdOverride: file.mode === "manual" ? file.fixedThresholdPercent : null,
    hysteresisPercent: file.hysteresisPercent,
    customInstructions: "",
  });
}

/** Migrate a 0.2.3 session-state threshold into a fresh file config (file wins when present). */
export function migrateSessionThreshold(session: { mode: RabbitMode; config: RabbitConfig }): Partial<RabbitFileConfig> {
  if (session.mode === "manual" && session.config.thresholdOverride !== null) {
    return { mode: "manual", fixedThresholdPercent: session.config.thresholdOverride };
  }
  if (session.mode === "auto" || session.mode === "manual" || session.mode === "off" || session.mode === "garden" || session.mode === "observe") {
    return { mode: session.mode };
  }
  return {};
}
