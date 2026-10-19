import type { PreservationPreset } from "./config.js";

/**
 * Preservation presets genuinely control the `customInstructions` Rabbit
 * attaches to Rabbit-requested native compactions. Pi independently
 * triggered (overflow/safety) compactions never see these instructions:
 * Rabbit is a passive observer there and must not claim otherwise.
 */
export const PRESET_INSTRUCTIONS: Record<PreservationPreset, string> = {
  balanced:
    "Preservation focus (Balanced): keep the general conversation, essential context, and active work. " +
    "Preserve user intent, current task, key decisions, and next steps in compact form.",
  continuity:
    "Preservation focus (Project Continuity): prioritise user instructions, architectural decisions, " +
    "active objectives, completed evidence with references, unresolved work and hypotheses, and the " +
    "next safe action. Keep repository, branch, revision, and acceptance state when relevant.",
  technical:
    "Preservation focus (Technical): prioritise commands, file paths, changed files, test results, " +
    "failures with exact error context, implementation state, and engineering constraints. " +
    "Keep identifiers, versions, and reproduction steps exact.",
};

export const PRESET_LABELS: Record<PreservationPreset, string> = {
  balanced: "Balanced — conversation, essentials, active work",
  continuity: "Project Continuity — decisions, evidence, next action",
  technical: "Technical — commands, files, tests, failures",
};

export function presetInstructions(preset: PreservationPreset): string {
  return PRESET_INSTRUCTIONS[preset] ?? PRESET_INSTRUCTIONS.balanced;
}
