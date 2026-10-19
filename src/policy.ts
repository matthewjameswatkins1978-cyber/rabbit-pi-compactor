export type RabbitMode = "auto" | "manual" | "off" | "garden" | "observe";

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
// Smart Auto gates (0.3.0): pressure floor, high-pressure fast path, minimum
// worthwhile savings, and growth trigger. Deterministic; no model calls.
export const SMART_AUTO_PRESSURE_FLOOR_PERCENT = 60;
export const SMART_AUTO_HIGH_PRESSURE_PERCENT = 75;
export const SMART_AUTO_MIN_SAVINGS_PERCENT = 10;
export const SMART_AUTO_MIN_SAVINGS_TOKENS = 15_000;
export const SMART_AUTO_GROWTH_TRIGGER_PERCENT = 2;
export const SMART_AUTO_SUMMARY_OVERHEAD_TOKENS = 4_000;

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

export interface SmartAutoSignals {
  readonly percent: number;
  readonly tokens: number;
  readonly effectiveBudget: number;
  /** Per-turn growth as percent of effective budget (current minus previous valid). */
  readonly growthPercentPerTurn: number | undefined;
  /** Pi native keepRecentTokens when readable from settings; undefined means unknown. */
  readonly keepRecentTokens: number | undefined;
}

export interface SmartAutoDecision {
  readonly shouldCompact: boolean;
  readonly reason: string;
}

/**
 * Deterministic Smart Auto decision. No model calls, no invented task knowledge.
 *
 * Compact when pressure is above the floor AND the estimated savings are
 * worthwhile AND (pressure is high OR context is growing fast). Below the
 * high-pressure mark with unknown retention, pressure alone is not enough:
 * the fallback requires high pressure and says so in the reason.
 */
export function decideSmartAuto(signals: SmartAutoSignals): SmartAutoDecision {
  const { percent, tokens, effectiveBudget, growthPercentPerTurn, keepRecentTokens } = signals;
  const floor = SMART_AUTO_PRESSURE_FLOOR_PERCENT;
  const high = SMART_AUTO_HIGH_PRESSURE_PERCENT;
  if (!Number.isFinite(percent) || !Number.isSafeInteger(tokens) || !Number.isSafeInteger(effectiveBudget) || effectiveBudget <= 0) {
    return { shouldCompact: false, reason: "usage unknown; Smart Auto never triggers without a measurement" };
  }
  if (percent < floor) {
    return { shouldCompact: false, reason: `pressure ${percent.toFixed(1)}% below Smart Auto floor ${floor}%` };
  }
  if (keepRecentTokens === undefined) {
    if (percent >= high) {
      return { shouldCompact: true, reason: `pressure ${percent.toFixed(1)}% at or above ${high}% (retention unknown; percent-only fallback)` };
    }
    return { shouldCompact: false, reason: `retention unknown and pressure ${percent.toFixed(1)}% below ${high}% fallback mark` };
  }
  const savings = tokens - keepRecentTokens - SMART_AUTO_SUMMARY_OVERHEAD_TOKENS;
  const savingsPercent = (savings / effectiveBudget) * 100;
  const minSavings = Math.max(
    Math.ceil((effectiveBudget * SMART_AUTO_MIN_SAVINGS_PERCENT) / 100),
    SMART_AUTO_MIN_SAVINGS_TOKENS,
  );
  if (savings < minSavings) {
    return { shouldCompact: false, reason: `estimated savings ${Math.max(0, savings).toLocaleString()} tokens below ${minSavings.toLocaleString()} minimum` };
  }
  if (percent >= high) {
    return { shouldCompact: true, reason: `pressure ${percent.toFixed(1)}% at or above ${high}%; savings ~${savingsPercent.toFixed(0)}% of budget` };
  }
  if (growthPercentPerTurn !== undefined && growthPercentPerTurn >= SMART_AUTO_GROWTH_TRIGGER_PERCENT) {
    return { shouldCompact: true, reason: `pressure ${percent.toFixed(1)}% with growth +${growthPercentPerTurn.toFixed(1)}%/turn; savings ~${savingsPercent.toFixed(0)}% of budget` };
  }
  return { shouldCompact: false, reason: `pressure ${percent.toFixed(1)}% holding below ${high}% with growth ${growthPercentPerTurn === undefined ? "unknown" : `+${growthPercentPerTurn.toFixed(1)}%/turn`} below +${SMART_AUTO_GROWTH_TRIGGER_PERCENT}%/turn` };
}
