# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.4] - 2026-05-02

### Fixed
- Show the boomerang summary in chat while keeping the hidden self-contained orchestrator handoff.

## [0.6.3] - 2026-05-02

### Fixed
- Made the hidden post-boomerang follow-up self-contained so agents do not search session logs for the just-created summary.

## [0.6.2] - 2026-05-02

### Fixed
- Prevented auto-compaction from immediately compacting tree-navigation boomerang summaries.

## [0.6.1] - 2026-05-01

### Changed
- Auto-boomerang mode is now one-shot and turns off after wrapping the next prompt.

## [0.6.0] - 2026-05-01

### Added
- Added session-only auto-boomerang mode, toggled with `Ctrl+Alt+B` or `/boomerang auto [on|off|toggle|status]`, so normal prompts can automatically run with boomerang summarization.

### Fixed
- Auto-boomerang now also wraps extension-sourced prompt-template command output, such as `/tldr` from prompt-template-model.

## [0.5.0] - 2026-05-01

### Added
- Expanded boomerang summaries into operational handoffs with outcome, changed files, relevant reads, command counts, validation commands, failures, and config metadata.
- Added a hidden follow-up trigger after successful boomerang returns so the orchestrator reads the new handoff summary immediately.

### Fixed
- Kept boomerang-related summary and compaction rows expanded from creation time, so Ctrl+O is never needed after a boomerang returns.

## [0.4.5] - 2026-04-30

### Fixed
- Expanded completed boomerang branch summaries by default so users no longer need to press Ctrl+O to reveal details.
- Avoided expanding the UI if a rethrow collapse is cancelled before boomerang still owns the collapse.

## [0.4.4] - 2026-04-22

### Fixed
- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Changed
- Added `typebox` as a runtime dependency for packaged installs.

## [0.4.3] - 2026-04-04

### Changed

- Added a `promptSnippet` for the `boomerang` tool so Pi 0.59+ includes it in the default tool prompt section and reliably discovers it during autonomous runs.

## [0.4.2] - 2026-04-03

### Fixed

- Boomerang branch summaries now keep the full `Outcome` text instead of truncating at 500 characters, so collapsed context preserves complete results for future turns.
- Preserved assistant formatting in `Outcome` summaries by normalizing line endings without flattening multiline content.

## [0.4.1] - 2026-04-03

### Changed

- Migrated boomerang session reset handling to the `session_start` lifecycle event and removed the legacy `session_switch` hook.
- Clarified `--rethrow` and `--loop` boomerang behavior in the README, including count requirements, alias precedence, and pass-by-pass execution details.

## [0.4.0] - 2026-03-18

### Added

- **`--rethrow N` syntax** — Run full multi-pass boomerang execution with context collapse between rethrows (for example `/boomerang /task --rethrow 3`)
- **Synchronous rethrow execution model** — Rethrows run in-command via `waitForIdle`, with per-rethrow collapse and accumulated summaries
- **Boomerang tool accepts a task parameter** — When enabled, the agent can call `boomerang({ task: "fix bugs --rethrow 3" })` to queue tasks with full rethrow/chain/template support

### Changed

- **Replaced loop syntax with `--rethrow N`** — The `Nx` loop syntax, convergence detection, and `--converge` flag are replaced by `--rethrow N`. Boomerang handles context collapse; pi-prompt-template-model owns inner loops via `--loop`.
- **Boomerang tool only registered when enabled** — Tool only appears in the agent's tool list after `/boomerang tool on`
- **`--loop N` in boomerang now maps to `--rethrow N`** — Prevents loop flags from being injected into rendered template prompts and keeps boomerang execution deterministic.
- **Loop alias mapping is now surfaced in UI** — Boomerang shows an info notification when `--loop` is auto-mapped to `--rethrow` so execution mode is explicit.
- **`--rethrow` now takes precedence over `--loop` when both are present** — Boomerang strips loop tokens and reports the precedence decision so loop flags never leak into rendered prompts.

### Fixed

- **Prevented premature collapse before agent output** — Command-mode boomerangs now wait for the queued task message to appear and for the first assistant message after that task before advancing chain steps or collapsing context, including cases where `getLeafId()` is transiently null when the task is queued.
- **Preserved template read errors instead of downgrading to "not found"** — Template I/O failures now surface explicit `Failed to read template ...` errors in single, chain, and rethrow flows.
- **Preserved skill read error details** — Skill load failures now include the underlying read error text (for example permissions or path/type errors) instead of a generic warning.
- **Preserved config persistence failures** — Config save failures now warn in the UI, and config load failures are logged with full error context.
- **Preserved model restore failures** — Restore now reports model restore failures as warnings instead of silently reporting successful restoration.
- **Stripped invalid numeric loop counts when `--rethrow` is present** — Inputs like `--rethrow 2 --loop 0` no longer leak `0` into rendered task arguments.
- **Stripped repeated `--loop` tokens when `--rethrow` is present** — Inputs like `--rethrow 2 --loop 0 --loop 3` now remove all loop metadata so no loop flags leak into rendered task arguments.
- **Prevented queued-tool task overwrites** — The boomerang tool now rejects queueing a second task while one is already queued instead of silently replacing the first queued task.
- **Model restoration no longer depends on command-context model snapshots** — Restore now uses runtime model snapshots, including tool-queued task starts, preventing stale command-context values from causing incorrect rollback targets.

## [0.3.0] - 2026-03-14

### Added

- **Loop execution** — Run tasks multiple times with `/boomerang /task 5x`. Each iteration collapses back to an auto-managed anchor point, with changes accumulating across iterations. Supports templates, chains, and plain tasks.
- **Convergence detection** — `--converge` flag stops the loop early if an iteration makes no file changes (e.g., `/boomerang /deslop 5x --converge`)
- **Loop-aware system prompt** — Agent is told which iteration it's on so it builds on previous work incrementally
- **Combined status indicators** — Shows `loop 2/5` during loops and `loop 2/5 · chain 1/3` for chain+loop combinations

## [0.2.1] - 2026-03-09

### Fixed

- Added missing `pi` manifest to package.json so pi can auto-discover the extension

## [0.2.0] - 2026-03-04

### Added

- **Chain execution** - Run multiple templates in sequence with `/boomerang /scout -> /planner -> /impl -- "task"`. Each step can have its own args, model, skill, and thinking level. Context collapses after the final step.
- **Prompt template execution** - `/boomerang /<template> [args...]` runs templates from `.pi/prompts/` with frontmatter support for `model`, `skill`, and `thinking`
- **Tool guidance** - Customize when the agent should use boomerang with `/boomerang guidance <text>` or inline with `/boomerang tool on <guidance>`
- **Config persistence** - Tool enabled state and guidance persist to `~/.pi/agent/boomerang.json` across pi restarts

### Changed

- Boomerang restores switched models and thinking levels after collapse, cancel, session start, and session switch
- **Improved summaries** - Now include agent's final response (truncated to 500 chars) as "Outcome" and a "Config" line showing model/thinking/skill changes

### Fixed

- Reject path-traversal template references outside prompts directories
- Clear template-scoped state on all cleanup paths

## [0.1.4] - 2026-03-03

### Changed

- **Boomerang tool is now disabled by default** - Agents were proactively calling the tool when they thought a task might be "large", which was too aggressive. Users must now explicitly enable with `/boomerang tool on`.

### Added

- `/boomerang tool` subcommand to check tool status
- `/boomerang tool on` to enable the boomerang tool for agents
- `/boomerang tool off` to disable the tool (default state)
- Tool enabled state persists across session switches (within same pi process)

## [0.1.3] - 2026-03-03

### Added

- Auto-skip rewind extension's file restore prompt during boomerang collapse (sets `globalThis.__boomerangCollapseInProgress` flag)

### Fixed

- Use valid theme color `"accent"` instead of invalid `"cyan"` for anchor status indicator
- Clear orphaned tool anchor state when starting command boomerang (prevents incorrect collapse target)

## [0.1.2] - 2026-03-02

### Fixed

- Prevent auto-compaction from triggering after tool-initiated collapse via `session_before_compact` hook
- Use entry ID tracking instead of boolean flag to avoid stale cancellations

## [0.1.1] - 2026-03-01

### Fixed

- README install instructions now show `pi install` command

## [0.1.0] - 2026-03-01

### Added

- `/boomerang <task>` command for autonomous task execution with context collapse
- `/boomerang anchor`, `/boomerang anchor show`, `/boomerang anchor clear` commands
- `/boomerang-cancel` command to abort active boomerang
- `boomerang` tool for agent-initiated context collapse (toggle anchor/collapse)
- Automatic summary generation from tool calls (file reads, writes, edits, bash commands)
- Status indicator in footer (yellow during execution, cyan for anchor)
- State clearing on session start/switch to prevent leakage

### Technical

- Uses `navigateTree()` for immediate UI updates (same mechanism as `/tree`)
- Falls back to `branchWithSummary()` for tool-only collapse when no command context available
