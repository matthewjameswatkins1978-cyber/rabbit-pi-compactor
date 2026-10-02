# Rabbit Pi Compactor 🐇

An adaptive policy layer around Pi's native compactor. Rabbit schedules an early compact at a completed-turn boundary; Pi still owns summarisation, recent-message retention, file tracking, overflow recovery, and safety compaction.

## Compatibility

- Pi SDK: **1.0.0**
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

Rabbit uses the active model's `contextWindow` from Pi's `getContextUsage()` API. It does not infer capacity from model names.

| Active context window | Rabbit trigger |
| --- | ---: |
| Up to 128K tokens | 90% |
| Between 128K and 256K | Linear interpolation from 90% to 35% |
| 256K tokens or more | 35% |

The adaptive policy is the default. On windows of 256K tokens or more, that policy triggers at 35%. Use `/rabbit threshold 35` to force a fixed 35% threshold for every model window. Rabbit requires an observed crossing from at-or-below the threshold to above it, then rearms only after reliable usage falls at least five percentage points below the threshold. It invokes `ctx.compact()` without awaiting it. Unknown (`null`) token usage never counts as zero and never triggers a compact.

Pi's native safety/overflow compaction remains enabled and can run first. Rabbit observes those compactions and disarms until usage recovers below the hysteresis boundary.

Pi 1.0.0 currently truncates each tool result passed into summary serialization to its first 2,000 characters. The Terror Bat fixture verifies that an early marker remains visible and a marker after that boundary is omitted. Raw session history remains intact; Rabbit does not add a second evidence store or alter Pi's serializer.

## Commands

- `/rabbit status` — show enabled state, current context use, active threshold, and last compact.
- `/rabbit off` / `/rabbit on` — disable or enable automatic Rabbit triggers.
- `/rabbit threshold 35` — set a fixed percentage.
- `/rabbit threshold adaptive` — restore the adaptive 90% / 35% policy.
- `/rabbit compact` — request Pi's native compactor manually.

The command does not disable or reconfigure Pi's own compaction safety.

## Development

```powershell
corepack pnpm install --ignore-scripts
corepack pnpm test
```

Automatic compactions add a small Rabbit receipt to Pi's existing session history. The receipt records the trigger percentage, context window, tokens before, Pi's estimated tokens after, and timestamp. The estimate is informational, not provider-exact usage.
