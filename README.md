# Rabbit Pi Compactor 🐇

An adaptive policy layer around Pi's native compactor. Rabbit schedules an early compact at a completed-turn boundary; Pi still owns summarisation, recent-message retention, file tracking, overflow recovery, and safety compaction.

## Compatibility

- Pi SDK: **1.2.0** (extension API; also loads under the installed Pi 1.3.0 CLI)
- Gary Pi: loads Rabbit through Pi's native extension loader after Pi installs it to the shared user or project package settings.
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

Gary Pi reads those same Pi package settings. After installation, refresh or reload extensions in Gary Pi; Rabbit appears in the Extensions list, where it can be enabled or disabled. Rabbit uses the same Pi extension runtime and session history and does not maintain a parallel transcript.

## Settings menu

Type `/rabbit` (or `/rabbit settings`) to open an interactive settings menu built on Pi's native selectors: arrow keys, Enter to pick, Escape to leave without changing anything. Everyday controls are **when to compact** (Smart Auto / Fixed Threshold / Garden / Observe / Off), **what to keep** (Balanced / Project Continuity / Technical), **Compact now**, and **Status**. Advanced settings (Pi native details, re-compact delay) stay tucked away. Every visible setting applies immediately and persists. Without a terminal UI (headless/RPC), `/rabbit` prints text guidance and the `/rabbit mode|threshold|preserve` commands keep working.

## Configuration file

Global preferences live in one validated JSON file, `~/.pi/agent/rabbit.json` (`RABBIT_CONFIG_PATH` overrides it for tests): mode, fixed threshold, preservation preset, and re-compact delay. Settings survive closing and reopening Pi. Garden units, queued requests, and decision receipts stay per-session custom entries in Pi's session branch and never leak into the global file. A 0.2.3 session threshold is migrated into the file once, never overwritten afterwards: the file wins on restart. Rabbit never touches Pi's own settings, credentials, or package configuration.

## Adaptive policy

Rabbit uses the active model's `contextWindow` and token count from Pi's `getContextUsage()` API. It does not infer capacity from model names.

Smart Auto compacts at a deterministic best moment, not a fixed percentage: pressure above a 60% floor AND worthwhile estimated savings AND (pressure at or above 75% OR context growing fast at +2%/turn or more). When Pi's recent-retention size is unknown, Smart Auto says so and uses a transparent percent-only fallback at 75%+. Every wait or fire carries a short human-readable reason shown in status and stored in the receipt. After a failed normal attempt, one bounded retry is permitted at the 96% emergency guard. These are operational starting points, not universal optima, and no extra model calls are made to decide. The effective budget is the reported context window less Pi's configured output reserve (including the exact provider/model override, when present). The numerator is Pi's measured context token count, which already includes the serialized system prompt and conversation; Rabbit does not subtract system prompt, messages, or tool output again. The default reserve is 16,384 tokens when no valid Pi setting is available. Manual accepts a 1–99% trigger on that same effective budget, defaulting to 90% when Manual is selected without an explicit value. Trigger pressure is separate from retention: Pi continues to own its recent-message tail and summary cut point.

Choose Smart Auto, Fixed Threshold, Garden, Observe, or Off with `/rabbit`, `/rabbit mode smart-auto|fixed|garden|observe|off` (`auto|manual` still work), or `/rabbit on|off`. Fixed Threshold accepts 1–99% (40% is the default example, adjustable in the menu or with `/rabbit threshold 40`); `/rabbit threshold adaptive` returns to Smart Auto. `observe` records pressure for diagnostics but never requests compaction. Modes, thresholds, presets, and delays persist to the configuration file. A completed compaction discards the pre-compaction baseline, reads Pi's current measurement again, records a receipt, and rearms only after measured usage drops below the Smart Auto floor (or the fixed mark) minus hysteresis.

Smart Auto fires at most once per arming: after a trigger it stays quiet until usage recovers below its floor minus hysteresis (Fixed Threshold rearms below its mark minus hysteresis). It invokes `ctx.compact()` without awaiting it. Unknown (`null`) token usage never counts as zero and never triggers a compact. The policy uses small deterministic signals only and never claims to know task completion.

Pi's native safety/overflow compaction remains enabled and can run first. Rabbit observes those compactions and disarms until usage recovers below the hysteresis boundary.

The verified Pi SDK 1.1.0 runtime truncates each tool result passed into summary serialization to its first 2,000 characters. The Terror Bat fixture verifies that an early marker remains visible and a marker after that boundary is omitted. Raw session history remains intact; Rabbit does not add a second evidence store or alter Pi's serializer.

## Garden mode

Garden is an agent-directed mode selected with `/rabbit mode garden`. It disables Rabbit's automatic threshold trigger, while Pi's native overflow and safety compaction remain enabled. The active agent uses the `rabbit_garden` tool to record continuity units, defer unresolved work, fold a completed unit through Pi's native compactor, compact the current mission, inspect Garden status, or restore exact evidence from a `pi-entry:<entryId>` reference.

Garden units, pending requests and decision receipts are stored as bounded custom entries in the existing Pi session branch. Compaction requests run only at Pi's `turn_end` boundary, are guarded against duplicate dispatch, and produce a truthful completion/failure receipt. Rabbit retains an independent physical-operation guard — at most one unacknowledged native compaction, never released by mode or session transitions — because Pi 1.2.0 does not serialize overlapping extension compactions. Queued requests never survive a session restart, session-tree change, or exit from Garden mode: in-flight work receives an interruption receipt and unexecuted requests a cancellation receipt (`/rabbit cancel` abandons a queued request before dispatch). Late callbacks from a previous session or mode can never mutate current state, and duplicate terminal notifications produce a single receipt.

Folding context is not completing work. `record` rejects a transition to `complete` while unresolved obligations remain, and FOLD requires a unit already explicitly recorded as complete with no unresolved work; a successful native compaction never changes a unit's completion status. A fold receipt records successful *context compaction*, not acceptance of the deliverable, and failed compaction never produces a completed receipt.

Evidence references distinguish verified proof from pointers: only `pi-entry:<entryId>` handles confirmed on the active session branch count as verified evidence (validated on record and restore; missing, malformed or off-branch handles are rejected). External `git:`/`file:`/`build:` references are retained as unverified pointers and surfaced as such in status and receipts. Garden does not delete session history or implement selective pruning. The legacy Auto, Manual and Off modes and existing `/rabbit` commands remain available.

## Commands

- `/rabbit` or `/rabbit settings` — open the interactive settings menu (default when no command is given).
- `/rabbit status` — show the mode in human language, selected model, context use, trigger with the last Smart Auto reason, preservation preset, armed state, sequence count, and method.
- `/rabbit mode smart-auto|fixed|garden|observe|off` — select the operating mode (`auto|manual` still work; `observe` never requests compaction).
- `/rabbit off` / `/rabbit on` — select Off or re-enable the prior Smart Auto/Fixed Threshold configuration.
- `/rabbit threshold 40` — set a Fixed Threshold percentage from 1–99 (40 is the default example).
- `/rabbit threshold adaptive` — return to Smart Auto.
- `/rabbit preserve balanced|continuity|technical` — choose what Rabbit-requested summaries keep. Presets shape only Rabbit-requested native compactions; Pi's own overflow compaction is unchanged.
- `/rabbit compact` — request Pi's native compactor manually.
- `/rabbit cancel` — abandon a queued (not yet dispatched) Garden request with a truthful cancellation receipt.
- `/rabbit doctor` — sanitised compatibility, state, policy and safety report, split into observed / estimated / inferred / missing sections.
- `/rabbit trace on|off|export [name]` — bounded sanitised event capture (200 events max, metadata only: no prompts, contents, keys or credentials); `export` notifies, stores the last 50 events in session history, and optionally writes the full JSON report to an ordinary `.json` filename (`[A-Za-z0-9][A-Za-z0-9._-]{0,199}.json`) inside the Pi working directory. Anything else — subdirectories, absolute paths, parent references, `:` alternate-data-stream syntax, and Windows reserved device names including `CONIN$`/`CONOUT$` — is refused before touching the filesystem, and existing files are never overwritten. Failure diagnostics use stable codes only (`session-too-small`, `already-compacted`, `compaction-cancelled`, `native-unavailable`, `compaction-failed`); raw exception text is never stored or reported.
- `rabbit_garden` — the agent-directed tool for status, continuity records, DEFER, FOLD, COMPACT, and exact evidence RESTORE.

The command does not disable or reconfigure Pi's own compaction safety.

## Development

```powershell
corepack pnpm install --ignore-scripts
corepack pnpm test
```

Automatic and manual compactions add a small Rabbit receipt to Pi's existing session history. It records trigger/reason, mode, context window, effective budget, output reserve, provider/model when available, local Pi method, sequence, measured before/after values when available, Pi's separate estimated-after value, and timestamp. Unknown measurements remain null; the estimate is informational, not provider-exact usage. Pi's compaction cut-point and recent verbatim tail remain the retention mechanism. Rabbit has no clean deterministic hook for classifying old tool output as disposable, so this version does not prune historical results. Mission identity, authority, repository, worktree, checkpoint and milestone state remain Gary Pi-owned state; Rabbit does not create a duplicate mission store.
