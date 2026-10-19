export { classifyFailure, createRabbitExtension, RABBIT_VERSION, RECEIPT_ENTRY, STATE_ENTRY, TRACE_EXPORT_ENTRY } from "./extension.js";
export type { RabbitFailureCode } from "./extension.js";
export { DEFAULT_FILE_CONFIG, DEFAULT_FIXED_THRESHOLD_PERCENT, RABBIT_FILE_CONFIG_VERSION, globalConfigPath, loadFileConfig, migrateSessionThreshold, saveFileConfig, toSessionConfig, validateFileConfig } from "./config.js";
export type { LoadedFileConfig, PreservationPreset, RabbitFileConfig } from "./config.js";
export { PRESET_INSTRUCTIONS, PRESET_LABELS, presetInstructions } from "./presets.js";
export { GARDEN_RECEIPT_ENTRY, isPiEntryReference, splitEvidenceReferences, validateEvidenceReferences } from "./garden.js";
export { RABBIT_COMPACTION_INSTRUCTIONS } from "./instructions.js";
export { AUTO_TRIGGER_PERCENT, crossedThreshold, decideSmartAuto, DEFAULT_CONFIG, DEFAULT_MANUAL_TRIGGER_PERCENT, DEFAULT_OUTPUT_RESERVE_TOKENS, EMERGENCY_GUARD_PERCENT, resolvePolicy, SMART_AUTO_GROWTH_TRIGGER_PERCENT, SMART_AUTO_HIGH_PRESSURE_PERCENT, SMART_AUTO_MIN_SAVINGS_PERCENT, SMART_AUTO_MIN_SAVINGS_TOKENS, SMART_AUTO_PRESSURE_FLOOR_PERCENT, SMART_AUTO_SUMMARY_OVERHEAD_TOKENS, validateConfig } from "./policy.js";
export type { RabbitConfig, RabbitMode, RabbitPolicy, SmartAutoDecision, SmartAutoSignals } from "./policy.js";

import { createRabbitExtension } from "./extension.js";
export default createRabbitExtension();
