export interface RabbitConfig {
  readonly smallWindowBoundary: number;
  readonly largeWindowBoundary: number;
  readonly smallWindowTargetPercent: number;
  readonly largeWindowTargetPercent: number;
  readonly thresholdOverride: number | null;
  readonly hysteresisPercent: number;
  readonly customInstructions: string;
}

export interface RabbitPolicy {
  readonly targetPercent: number;
  readonly targetTokens: number;
  readonly band: "small" | "interpolated" | "large" | "override";
}

export const DEFAULT_CONFIG: RabbitConfig = {
  smallWindowBoundary: 131_072,
  largeWindowBoundary: 262_144,
  smallWindowTargetPercent: 90,
  largeWindowTargetPercent: 35,
  thresholdOverride: null,
  hysteresisPercent: 5,
  customInstructions: "",
};

export function resolvePolicy(
  contextWindow: number | undefined,
  config: RabbitConfig = DEFAULT_CONFIG,
): RabbitPolicy | undefined {
  if (!Number.isSafeInteger(contextWindow) || contextWindow! <= 0) return undefined;
  const capacity = contextWindow!;
  if (config.thresholdOverride !== null) {
    return {
      targetPercent: config.thresholdOverride,
      targetTokens: Math.ceil((capacity * config.thresholdOverride) / 100),
      band: "override",
    };
  }
  if (capacity <= config.smallWindowBoundary) {
    return {
      targetPercent: config.smallWindowTargetPercent,
      targetTokens: Math.ceil((capacity * config.smallWindowTargetPercent) / 100),
      band: "small",
    };
  }
  if (capacity >= config.largeWindowBoundary) {
    return {
      targetPercent: config.largeWindowTargetPercent,
      targetTokens: Math.ceil((capacity * config.largeWindowTargetPercent) / 100),
      band: "large",
    };
  }
  const fraction =
    (capacity - config.smallWindowBoundary) /
    (config.largeWindowBoundary - config.smallWindowBoundary);
  const targetPercent =
    config.smallWindowTargetPercent +
    fraction * (config.largeWindowTargetPercent - config.smallWindowTargetPercent);
  return {
    targetPercent,
    targetTokens: Math.ceil((capacity * targetPercent) / 100),
    band: "interpolated",
  };
}

export function validateConfig(input: Partial<RabbitConfig>): RabbitConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Rabbit configuration must be an object.");
  }
  const config = { ...DEFAULT_CONFIG, ...input };
  if (!Number.isSafeInteger(config.smallWindowBoundary) || config.smallWindowBoundary < 1024) {
    throw new Error("smallWindowBoundary must be a safe integer of at least 1,024.");
  }
  if (
    !Number.isSafeInteger(config.largeWindowBoundary) ||
    config.largeWindowBoundary <= config.smallWindowBoundary
  ) {
    throw new Error("largeWindowBoundary must exceed smallWindowBoundary.");
  }
  for (const [name, value] of [
    ["smallWindowTargetPercent", config.smallWindowTargetPercent],
    ["largeWindowTargetPercent", config.largeWindowTargetPercent],
    ["hysteresisPercent", config.hysteresisPercent],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value >= 100) {
      throw new Error(`${name} must be between 0 and 99.`);
    }
  }
  if (config.smallWindowTargetPercent <= config.largeWindowTargetPercent) {
    throw new Error("The small-window target must exceed the large-window target.");
  }
  if (
    config.thresholdOverride !== null &&
    (!Number.isFinite(config.thresholdOverride) ||
      config.thresholdOverride <= 0 ||
      config.thresholdOverride >= 100)
  ) {
    throw new Error("threshold must be greater than 0 and less than 100.");
  }
  if (typeof config.customInstructions !== "string" || config.customInstructions.length > 8000) {
    throw new Error("customInstructions must be a string of at most 8,000 characters.");
  }
  return config;
}

export function crossedThreshold(
  previousPercent: number | undefined,
  currentPercent: number,
  thresholdPercent: number,
): boolean {
  return (
    previousPercent !== undefined &&
    previousPercent <= thresholdPercent &&
    currentPercent > thresholdPercent
  );
}
