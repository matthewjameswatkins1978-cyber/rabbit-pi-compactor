export type RabbitMode = "auto" | "manual" | "off";

export interface RabbitConfig {
  /** Manual trigger percentage. Auto uses AUTO_TRIGGER_PERCENT. */
  readonly thresholdOverride: number | null;
  readonly hysteresisPercent: number;
  readonly customInstructions: string;
}

export interface RabbitPolicy {
  readonly targetPercent: number;
  readonly targetTokens: number;
  readonly effectiveBudget: number;
  readonly reserveTokens: number;
  readonly emergencyPercent: number;
  readonly emergencyTokens: number;
  readonly band: "auto" | "manual";
}

export const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_384;
// Initial operational targets, not claims of universally optimal values.
export const AUTO_TRIGGER_PERCENT = 88;
export const DEFAULT_MANUAL_TRIGGER_PERCENT = 90;
export const EMERGENCY_GUARD_PERCENT = 96;

export const DEFAULT_CONFIG: RabbitConfig = {
  thresholdOverride: null,
  hysteresisPercent: 5,
  customInstructions: "",
};

export function resolvePolicy(
  contextWindow: number | undefined,
  config: RabbitConfig = DEFAULT_CONFIG,
  reserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
): RabbitPolicy | undefined {
  if (!Number.isSafeInteger(contextWindow) || contextWindow! <= 0 || !Number.isSafeInteger(reserveTokens) || reserveTokens < 0) return undefined;
  const effectiveBudget = contextWindow! - reserveTokens;
  if (effectiveBudget <= 0) return undefined;
  const targetPercent = config.thresholdOverride ?? AUTO_TRIGGER_PERCENT;
  return {
    targetPercent,
    targetTokens: Math.ceil((effectiveBudget * targetPercent) / 100),
    effectiveBudget,
    reserveTokens,
    emergencyPercent: EMERGENCY_GUARD_PERCENT,
    emergencyTokens: Math.ceil((effectiveBudget * EMERGENCY_GUARD_PERCENT) / 100),
    band: config.thresholdOverride === null ? "auto" : "manual",
  };
}

export function validateConfig(input: Partial<RabbitConfig>): RabbitConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Rabbit configuration must be an object.");
  }
  const config: RabbitConfig = {
    thresholdOverride: input.thresholdOverride ?? DEFAULT_CONFIG.thresholdOverride,
    hysteresisPercent: input.hysteresisPercent ?? DEFAULT_CONFIG.hysteresisPercent,
    customInstructions: input.customInstructions ?? DEFAULT_CONFIG.customInstructions,
  };
  if (config.thresholdOverride !== null &&
    (!Number.isSafeInteger(config.thresholdOverride) || config.thresholdOverride < 1 || config.thresholdOverride > 99)) {
    throw new Error("threshold must be a whole percentage from 1 to 99.");
  }
  if (!Number.isFinite(config.hysteresisPercent) || config.hysteresisPercent < 0 || config.hysteresisPercent >= 100) {
    throw new Error("hysteresisPercent must be between 0 and 99.");
  }
  if (typeof config.customInstructions !== "string" || config.customInstructions.length > 8000) {
    throw new Error("customInstructions must be a string of at most 8,000 characters.");
  }
  return config;
}

export function crossedThreshold(
  previousTokens: number | undefined,
  currentTokens: number,
  thresholdTokens: number,
): boolean {
  return previousTokens !== undefined && previousTokens <= thresholdTokens && currentTokens > thresholdTokens;
}
