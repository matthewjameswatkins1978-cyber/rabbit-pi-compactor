export { createRabbitExtension, RECEIPT_ENTRY, STATE_ENTRY } from "./extension.js";
export { RABBIT_COMPACTION_INSTRUCTIONS } from "./instructions.js";
export { AUTO_TRIGGER_PERCENT, crossedThreshold, DEFAULT_CONFIG, DEFAULT_MANUAL_TRIGGER_PERCENT, DEFAULT_OUTPUT_RESERVE_TOKENS, EMERGENCY_GUARD_PERCENT, resolvePolicy, validateConfig } from "./policy.js";
export type { RabbitConfig, RabbitMode, RabbitPolicy } from "./policy.js";

import { createRabbitExtension } from "./extension.js";
export default createRabbitExtension();
