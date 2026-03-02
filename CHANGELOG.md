# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
