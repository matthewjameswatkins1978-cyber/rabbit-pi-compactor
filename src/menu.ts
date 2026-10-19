import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PreservationPreset, RabbitFileConfig } from "./config.js";
import { PRESET_LABELS } from "./presets.js";
import type { RabbitMode } from "./policy.js";

export interface RabbitMenuDeps {
  readonly getConfig: () => RabbitFileConfig;
  readonly getStatusText: () => string;
  readonly getAdvancedText: () => string;
  readonly setMode: (mode: RabbitMode) => string;
  readonly setFixedThreshold: (percent: number) => string;
  readonly setPreservation: (preset: PreservationPreset) => string;
  readonly setHysteresis: (percent: number) => string;
  readonly compactNow: () => string;
}

const MODE_LABELS: Record<RabbitMode, string> = {
  auto: "Smart Auto",
  manual: "Fixed Threshold",
  garden: "Garden",
  observe: "Observe",
  off: "Off",
};

function modeLine(mode: RabbitMode, config: RabbitFileConfig): string {
  const current = config.mode === mode ? "● " : "○ ";
  switch (mode) {
    case "auto":
      return `${current}Smart Auto — Rabbit picks the best moment`;
    case "manual":
      return `${current}Fixed Threshold — compact at ${config.fixedThresholdPercent}% when I choose`;
    case "garden":
      return `${current}Garden — I direct compaction as the agent`;
    case "observe":
      return `${current}Observe — watch only, never compact`;
    case "off":
      return `${current}Off — no Rabbit compaction`;
  }
}

function preservationLine(preset: PreservationPreset, config: RabbitFileConfig): string {
  return `${config.preservation === preset ? "● " : "○ "}${PRESET_LABELS[preset]}`;
}

/**
 * Native-selector settings menu. Keyboard-friendly, no custom components.
 * Every choice applies immediately and persists. Cancellation (Escape) simply
 * closes the menu: nothing is changed unless an option was picked.
 * Headless/RPC callers get a text summary instead: no terminal UI is assumed.
 */
export async function openRabbitMenu(ctx: ExtensionCommandContext, deps: RabbitMenuDeps): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(`${deps.getStatusText()}\n\nHeadless mode: change settings with /rabbit mode, /rabbit threshold, or /rabbit preserve commands.`, "info");
    return;
  }
  for (;;) {
    const config = deps.getConfig();
    const choice = await ctx.ui.select("🐇 Rabbit — context settings", [
      modeLine(config.mode, config),
      `When to compact — ${config.mode === "manual" ? `fixed at ${config.fixedThresholdPercent}%` : MODE_LABELS[config.mode]}`,
      `What to keep — ${PRESET_LABELS[config.preservation]}`,
      "Compact now",
      "Advanced settings",
      `Status — what Rabbit is doing`,
      "Done",
    ]);
    if (choice === undefined || choice === "Done") return;
    if (choice.startsWith("● Smart Auto") || choice.startsWith("○ Smart Auto")) {
      ctx.ui.notify(deps.setMode("auto"), "info");
    } else if (choice.startsWith("● Fixed Threshold") || choice.startsWith("○ Fixed Threshold")) {
      await pickFixedThreshold(ctx, deps);
    } else if (choice.startsWith("● Garden") || choice.startsWith("○ Garden")) {
      ctx.ui.notify(deps.setMode("garden"), "info");
    } else if (choice.startsWith("● Observe") || choice.startsWith("○ Observe")) {
      ctx.ui.notify(deps.setMode("observe"), "info");
    } else if (choice.startsWith("● Off") || choice.startsWith("○ Off")) {
      ctx.ui.notify(deps.setMode("off"), "info");
    } else if (choice.startsWith("When to compact")) {
      await pickMode(ctx, deps);
    } else if (choice.startsWith("What to keep")) {
      await pickPreservation(ctx, deps);
    } else if (choice === "Compact now") {
      ctx.ui.notify(deps.compactNow(), "info");
    } else if (choice === "Advanced settings") {
      await pickAdvanced(ctx, deps);
    } else if (choice.startsWith("Status")) {
      ctx.ui.notify(deps.getStatusText(), "info");
    }
  }
}

async function pickMode(ctx: ExtensionCommandContext, deps: RabbitMenuDeps): Promise<void> {
  const config = deps.getConfig();
  const choice = await ctx.ui.select("When should Rabbit compact?", [
    modeLine("auto", config),
    modeLine("manual", config),
    modeLine("garden", config),
    modeLine("observe", config),
    modeLine("off", config),
    "← Back",
  ]);
  if (choice === undefined || choice === "← Back") return;
  if (choice.includes("Smart Auto")) {
    ctx.ui.notify(deps.setMode("auto"), "info");
  } else if (choice.includes("Fixed Threshold")) {
    await pickFixedThreshold(ctx, deps);
  } else if (choice.includes("Garden")) {
    ctx.ui.notify(deps.setMode("garden"), "info");
  } else if (choice.includes("Observe")) {
    ctx.ui.notify(deps.setMode("observe"), "info");
  } else if (choice.includes("Off")) {
    ctx.ui.notify(deps.setMode("off"), "info");
  }
}

async function pickFixedThreshold(ctx: ExtensionCommandContext, deps: RabbitMenuDeps): Promise<void> {
  const config = deps.getConfig();
  const mark = (percent: number): string => `${config.fixedThresholdPercent === percent ? "● " : "○ "}${percent}%`;
  const choice = await ctx.ui.select("Compact when context reaches…", [
    mark(25),
    mark(40),
    mark(50),
    mark(60),
    mark(75),
    "Custom percentage…",
    "← Back",
  ]);
  if (choice === undefined || choice === "← Back") return;
  if (choice === "Custom percentage…") {
    const raw = await ctx.ui.input("Fixed threshold percentage", "1–99, e.g. 40");
    if (raw === undefined) return;
    const percent = Number(raw.trim());
    if (!Number.isSafeInteger(percent) || percent < 1 || percent > 99) {
      ctx.ui.notify("Threshold must be a whole percentage from 1 to 99; nothing changed.", "warning");
      return;
    }
    ctx.ui.notify(deps.setFixedThreshold(percent), "info");
    return;
  }
  const percent = Number(choice.replace("● ", "").replace("○ ", "").replace("%", ""));
  if (Number.isSafeInteger(percent)) ctx.ui.notify(deps.setFixedThreshold(percent), "info");
}

async function pickPreservation(ctx: ExtensionCommandContext, deps: RabbitMenuDeps): Promise<void> {
  const config = deps.getConfig();
  const choice = await ctx.ui.select("What should summaries keep?", [
    preservationLine("balanced", config),
    preservationLine("continuity", config),
    preservationLine("technical", config),
    "← Back",
  ]);
  if (choice === undefined || choice === "← Back") return;
  if (choice.includes("Balanced")) ctx.ui.notify(deps.setPreservation("balanced"), "info");
  else if (choice.includes("Continuity")) ctx.ui.notify(deps.setPreservation("continuity"), "info");
  else if (choice.includes("Technical")) ctx.ui.notify(deps.setPreservation("technical"), "info");
}

async function pickAdvanced(ctx: ExtensionCommandContext, deps: RabbitMenuDeps): Promise<void> {
  for (;;) {
    const choice = await ctx.ui.select("Advanced settings", [
      "View Pi native compaction details",
      "Adjust re-compact delay (hysteresis)",
      "← Back",
    ]);
    if (choice === undefined || choice === "← Back") return;
    if (choice.startsWith("View Pi")) {
      ctx.ui.notify(deps.getAdvancedText(), "info");
    } else if (choice.startsWith("Adjust")) {
      const raw = await ctx.ui.input("Re-compact delay as % of budget", "0–99, current kept on cancel");
      if (raw === undefined) return;
      const percent = Number(raw.trim());
      if (!Number.isFinite(percent) || percent < 0 || percent >= 100) {
        ctx.ui.notify("Hysteresis must be between 0 and 99; nothing changed.", "warning");
        return;
      }
      ctx.ui.notify(deps.setHysteresis(percent), "info");
    }
  }
}
