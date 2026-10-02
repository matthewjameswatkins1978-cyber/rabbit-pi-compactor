export { createRabbitExtension, RECEIPT_ENTRY, STATE_ENTRY } from "./extension.js";
export { RABBIT_COMPACTION_INSTRUCTIONS } from "./instructions.js";
export { crossedThreshold, DEFAULT_CONFIG, resolvePolicy, validateConfig } from "./policy.js";
export type { RabbitConfig, RabbitPolicy } from "./policy.js";

import { createRabbitExtension } from "./extension.js";
export default createRabbitExtension();
