<p>
  <img src="banner.png" alt="pi-boomerang" width="1100">
</p>

# pi-boomerang

**Token-efficient autonomous task execution with automatic context summarization for [pi coding agent](https://github.com/badlogic/pi-mono).**

```
/boomerang Fix the login bug
```

The agent executes autonomously. When done, the raw turn history is replaced in future context by an expanded handoff summary—work gets done, tokens get saved, and the orchestrator immediately gets a follow-up turn.

## Why

Long autonomous tasks consume massive context. A bug fix that reads 10 files, makes 5 edits, and runs tests might burn 50k tokens. With pi-boomerang, the LLM only sees:

```
[BOOMERANG COMPLETE]
Task: "Fix the login bug"

Outcome:
Fixed the login bug by correcting the JWT validation logic...

Changed Files:
- src/auth.ts
- src/login.ts

Relevant Reads:
- src/session.ts

Commands:
- Ran 3 command(s)
- Validation: `npm test`
- Failures: none detected
```

Same outcome. Fraction of the tokens. The session tree preserves full history for `/tree` navigation if you need it.

An inverted [D-Mail](https://steins-gate.fandom.com/wiki/D-Mail): where D-Mail rewrites reality while the observer remembers, boomerang rewrites the observer while reality persists. The session tree is your Reading Steiner.

## Install

```bash
pi install pi-boomerang
```

Then restart pi to load the extension.

## Quick Start

```bash
# Plain task
/boomerang Refactor the auth module to use JWT

# Run a prompt template
/boomerang /commit "fix auth bug"

# Chain templates together
/boomerang /scout "map the auth module" -> /planner "design JWT refresh" -> /impl

# Toggle auto-boomerang mode for every normal prompt
# Shortcut: Ctrl+Alt+B
/boomerang auto on

# Cancel mid-task (no summary)
/boomerang-cancel
```

The agent works without asking questions, making reasonable assumptions. When complete, everything returns into a summary branch. The summary stays expanded in the UI and includes operational handoff context such as changed files, relevant reads, validation commands, failures, model/thinking/skill config, and the final outcome.

## Chain Execution

Run multiple templates in sequence with a single summary return at the end:

```bash
/boomerang /scout "analyze the codebase" -> /planner "design the fix" -> /impl "build it"
```

Each step can specify its own args inline. You can also set global args as a fallback for steps without inline args:

```bash
/boomerang /scout -> /planner -> /impl -- "build the auth system"
```

Each template's frontmatter controls model, skill, and thinking level for that step. Scout runs on sonnet, planner on opus, impl on whatever—boomerang switches automatically and restores your original config after the summary return.

Status indicator shows progress as `chain 1/3`, `chain 2/3`, etc.

## Rethrow Execution

Use `--rethrow N` to run the full task N times, summarizing context between each pass:

```bash
/boomerang /deslop --rethrow 3
/boomerang "improve code quality" --rethrow 2
/boomerang /scout -> /impl --rethrow 2 -- "auth module"
```

How it works in boomerang mode:

- `N` is required and must be `1-999`
- each pass does: execute task -> summarize context -> start next pass
- file changes persist on disk across passes
- each new pass sees accumulated summaries from prior passes, not full raw turn history
- rethrow uses an internal auto-anchor at the current leaf for that run

Status shows `rethrow 2/3`, and for chain rethrows `rethrow 2/3 · chain 1/2`.

`--loop N` compatibility in boomerang:

- `/boomerang ... --loop N` is treated as alias for `/boomerang ... --rethrow N`
- if both flags are present, `--rethrow` wins and `--loop` is ignored
- boomerang strips loop metadata from the rendered task so inner prompt args do not receive `--loop` tokens
- bare `--loop` (no count) is invalid in boomerang and returns `--loop requires a count (1-999)`

Examples:

```bash
# alias -> rethrow
/boomerang /deslop --loop 2

# mixed flags: --rethrow takes precedence
/boomerang /deslop --rethrow 3 --loop 9
```

Cancel mid-rethrow with `/boomerang-cancel`.

## Prompt Templates

If the task starts with `/`, boomerang treats it as a template reference:

```bash
/boomerang /commit "fix the auth bug"
/boomerang /codex/review "the auth module"
```

Templates load from `<cwd>/.pi/prompts/` first, then `~/.pi/agent/prompts/`. Subdirectories map to path segments (`/codex/review` → `codex/review.md`).

Frontmatter fields:

```markdown
---
model: claude-opus-4-6
skill: git-workflow
thinking: xhigh
---
Commit current work. $@
```

- `model` — switches before the task, restores after
- `skill` — injects into the system prompt
- `thinking` — sets thinking level, restores after
- `$@` expands to all args, `$1` `$2` etc. for positional

## Auto Mode

Press `Ctrl+Alt+B` or run `/boomerang auto on` to make every normal submitted prompt run as a boomerang task. Auto mode includes prompt templates such as `/review`, but it does not wrap Pi control commands like `/boomerang`, `/model`, or `/tree`.

Auto mode is session-only and resets when a session starts. Use `/boomerang auto off`, `/boomerang auto toggle`, or `Ctrl+Alt+B` again to turn it off. The footer shows `🪃 auto` while it is enabled and idle. If you enable it with the shortcut before any `/boomerang` command has initialized a command context, the first summary may need `/reload` to refresh the display; the agent still receives the summarized context.

## Anchor Mode

By default, each boomerang summarizes just its own work. Set an anchor when you want multiple tasks to share the same summary point:

```bash
/boomerang anchor              # set anchor here
/boomerang "task A"            # summarizes to anchor with summary A
/boomerang "task B"            # summarizes to anchor with summaries A + B
/boomerang anchor clear        # remove anchor
```

Summaries accumulate, so each task's context includes what came before.

## Agent-Callable Tool

When enabled, the extension registers a `boomerang` tool the agent can call directly. Two modes:

**Task mode** — pass a task string and it runs autonomously when the current turn ends:

```
boomerang({ task: "refactor the auth module" })
boomerang({ task: "/deslop --rethrow 3" })
boomerang({ task: '/scout -> /impl -- "auth module"' })
```

Supports everything the command does: templates, chains, `--rethrow N`. The task queues and executes after the agent's current turn completes.

**Anchor mode** — call with no task to toggle an anchor/summary point. First call sets the anchor, second call summarizes everything since the anchor. Useful for self-managed context without user intervention.

**Disabled by default** because agents got too aggressive with it. Enable with:

```bash
/boomerang tool on
```

You can provide guidance for when the agent should use it:

```bash
/boomerang tool on "Use only for tasks that modify 3+ files"
/boomerang guidance "Use for refactoring or multi-step implementations"
```

Tool state and guidance persist to `~/.pi/agent/boomerang.json` across restarts.

One quirk: tool-initiated anchor summaries may not update the UI immediately (the agent sees the summarized context, but chat display can lag until `/reload`).

## Commands

| Command | What it does |
|---------|--------------|
| `Ctrl+Alt+B` | Toggle auto-boomerang mode |
| `/boomerang auto [on\|off\|toggle\|status]` | Control auto-boomerang mode for normal prompts |
| `/boomerang <task>` | Execute and summarize context |
| `/boomerang <task> --rethrow N` | Re-run full task N times with summaries between rethrows |
| `/boomerang <task> --loop N` | Alias for `--rethrow N` in boomerang mode |
| `/boomerang /<template> [args]` | Run template and summarize context |
| `/boomerang /a -> /b -> /c` | Chain templates |
| `/boomerang /a -> /b --rethrow 2` | Chain templates, then rethrow full chain twice |
| `/boomerang-cancel` | Abort without summarizing |
| `/boomerang anchor` | Set summary point |
| `/boomerang anchor show` | Show anchor info |
| `/boomerang anchor clear` | Remove anchor |
| `/boomerang tool [on\|off]` | Enable/disable agent tool |
| `/boomerang guidance [text]` | Set/show/clear guidance |

## vs pi-context

[pi-context](https://github.com/ttttmr/pi-context) gives the agent Git-like tools to manage its own context—create milestones, monitor token usage, decide when to squash.

The problem: LLMs cut corners when told about resource limits. "You're at 80% capacity" triggers scarcity mindset—rushing, skipping exploration, shallower analysis.

pi-boomerang keeps the worker agent unaware. It sees the task and works thoroughly; the summarization happens invisibly, then the orchestrator is prompted to read the resulting handoff summary.

## File State

Boomerang only summarizes *context/tokens*—it never touches file state. All file changes made during the task are preserved. This is intentional; restoring files after the task would undo the work boomerang just completed.

The [rewind](https://github.com/badlogic/pi-mono/tree/main/extensions/rewind) extension is **not required**. Install it separately if you want to manually restore previous file states via `/tree` or `/fork`. Boomerang operates independently; rewind will not prompt during boomerang-triggered context summarization.

## Limitations

- Summary is heuristic—extracts file operations, validation commands, and failures from recorded tool calls/results, so it may miss semantic details
- Agent might still ask questions despite instructions (boomerang completes anyway)
- Anchor state is in-memory only, clears on session start/switch
- Tool-initiated summaries may not update UI immediately (`/reload` to refresh)
