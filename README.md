# Rabbit Pi Compactor 🐇

An adaptive policy layer around Pi's native compactor. Rabbit schedules an early compact at a completed-turn boundary; Pi still owns summarisation, recent-message retention, file tracking, overflow recovery, and safety compaction.

## Compatibility

- Pi SDK: **1.1.0**
- Pi Studio: loads Rabbit through its native extension loader after Pi installs it to the shared user or project package settings.
- Does not modify Pi's `reserveTokens` or replace the native compaction engine.

## Install

Install the GitHub package with Pi's CLI for your user account:

```powershell
pi install git:github.com/matthewjameswatkins1978-cyber/rabbit-pi-compactor
```

For one project only:

```powershell
pi install git:github.com/matthewjameswatkins1978-cyber/rabbit-pi-compactor --local
```

Pi Studio reads those same Pi package settings. After installation, refresh or reload extensions in Studio; Rabbit appears in the Extensions list, where you can enable or disable it. Rabbit uses the same Pi extension runtime and session history and does not maintain a parallel transcript.

## Adaptive policy

Rabbit uses the active model's `contextWindow` and token count from Pi's `getContextUsage()` API. It does not infer capacity from model names.

Auto triggers on a measured crossing of 88% of the active model's effective budget. After a failed normal attempt, the initial emergency guard permits one bounded retry at a crossing of 96%. These are operational starting points, not universal optima. The effective budget is the reported context window less Pi's configured output reserve (including the exact provider/model override, when present). The numerator is Pi's measured context token count, which already includes the serialized system prompt and conversation; Rabbit does not subtract system prompt, messages, or tool output again. The default reserve is 16,384 tokens when no valid Pi setting is available. Manual accepts a 1–99% trigger on that same effective budget, defaulting to 90% when Manual is selected without an explicit value. Trigger pressure is separate from retention: Pi continues to own its recent-message tail and summary cut point.

Choose a mode with `/rabbit mode auto|manual|off`. `/rabbit threshold 1-99` selects Manual with that threshold; `/rabbit threshold adaptive` returns to Auto. `/rabbit on` re-enables the last Auto or Manual configuration; `/rabbit off` selects Off. Mode and Manual threshold are persisted in the session's existing custom entries. A completed compaction discards the pre-compaction crossing baseline, reads Pi's current measurement again, records a receipt, and rearms only after measured usage is below the hysteresis boundary.

Rabbit requires an observed token-count crossing from at-or-below the exact trigger token to above it, then rearms after measured usage falls below the trigger by the configured hysteresis. It invokes `ctx.compact()` without awaiting it. Unknown (`null`) token usage never counts as zero and never triggers a compact. Auto uses one conservative model-relative rule across small and large windows; it does not claim to be an empirically optimal curve.

Pi's native safety/overflow compaction remains enabled and can run first. Rabbit observes those compactions and disarms until usage recovers below the hysteresis boundary.

The verified Pi SDK 1.1.0 runtime truncates each tool result passed into summary serialization to its first 2,000 characters. The Terror Bat fixture verifies that an early marker remains visible and a marker after that boundary is omitted. Raw session history remains intact; Rabbit does not add a second evidence store or alter Pi's serializer.

## Commands

- `/rabbit status` — show mode, selected model, context use, output reserve, effective budget, trigger, armed state, sequence count, and method.
- `/rabbit mode auto|manual|off` — select the operating mode.
- `/rabbit off` / `/rabbit on` — select Off or re-enable the prior Auto/Manual configuration.
- `/rabbit threshold 90` — set a Manual trigger percentage from 1–99.
- `/rabbit threshold adaptive` — restore Auto.
- `/rabbit compact` — request Pi's native compactor manually.

The command does not disable or reconfigure Pi's own compaction safety.

## Development

```powershell
corepack pnpm install --ignore-scripts
corepack pnpm test
```

Automatic and manual compactions add a small Rabbit receipt to Pi's existing session history. It records trigger/reason, mode, context window, effective budget, output reserve, provider/model when available, local Pi method, sequence, measured before/after values when available, Pi's separate estimated-after value, and timestamp. Unknown measurements remain null; the estimate is informational, not provider-exact usage. Pi's compaction cut-point and recent verbatim tail remain the retention mechanism. Rabbit has no clean deterministic hook for classifying old tool output as disposable, so this version does not prune historical results. Mission identity, authority, repository, worktree, checkpoint and milestone state remain Studio-owned state; Rabbit does not create a duplicate mission store.
