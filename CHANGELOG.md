# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
