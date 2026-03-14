<p>
  <img src="banner.png" alt="pi-boomerang" width="1100">
</p>

# pi-boomerang

**Token-efficient autonomous task execution with automatic context collapse for [pi coding agent](https://github.com/badlogic/pi-mono).**

```
/boomerang Fix the login bug
```

The agent executes autonomously. When done, the entire exchange collapses to a brief summary—work gets done, tokens get saved.

## Why

Long autonomous tasks consume massive context. A bug fix that reads 10 files, makes 5 edits, and runs tests might burn 50k tokens. With pi-boomerang, the LLM only sees:

```
[BOOMERANG COMPLETE]
Task: "Fix the login bug"
Actions: read 10 file(s), modified src/auth.ts, src/login.ts, ran 3 command(s).
Outcome: Fixed the login bug by correcting the JWT validation logic...
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

# Cancel mid-task (no collapse)
/boomerang-cancel
```

The agent works without asking questions, making reasonable assumptions. When complete, everything collapses into a summary branch.

## Chain Execution

Run multiple templates in sequence with a single collapse at the end:

```bash
/boomerang /scout "analyze the codebase" -> /planner "design the fix" -> /impl "build it"
```

Each step can specify its own args inline. You can also set global args as a fallback for steps without inline args:

```bash
/boomerang /scout -> /planner -> /impl -- "build the auth system"
```

Each template's frontmatter controls model, skill, and thinking level for that step. Scout runs on sonnet, planner on opus, impl on whatever—boomerang switches automatically and restores your original config after collapse.

Status indicator shows progress as `chain 1/3`, `chain 2/3`, etc.

## Loop Execution

Run a task multiple times with changes accumulating across iterations:

```bash
/boomerang /deslop 5x
/boomerang /scout -> /impl 3x -- "auth module"
/boomerang "improve code quality" 10x --converge
```

Each iteration collapses back to the same anchor point. The agent sees all previous iteration summaries, so it builds on earlier work rather than starting from scratch.

Add `--converge` to stop early when an iteration makes no file changes — useful for iterative improvement tasks that naturally converge.

Status shows `loop 2/5` during execution. Cancel mid-loop with `/boomerang-cancel`.

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

## Anchor Mode

By default, each boomerang collapses just its own work. Set an anchor when you want multiple tasks to share the same collapse point:

```bash
/boomerang anchor              # set anchor here
/boomerang "task A"            # collapses to anchor with summary A
/boomerang "task B"            # collapses to anchor with summaries A + B
/boomerang anchor clear        # remove anchor
```

Summaries accumulate, so each task's context includes what came before.

## Agent-Callable Tool

The extension registers a `boomerang` tool that agents can call directly. The agent sets an anchor, does work, calls boomerang again to collapse. Useful for self-managed context without user intervention.

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

One quirk: tool-initiated collapse may not update the UI immediately (the context IS collapsed, agent sees it, but chat display lags until `/reload`).

## Commands

| Command | What it does |
|---------|--------------|
| `/boomerang <task>` | Execute and collapse |
| `/boomerang <task> Nx` | Run task N times with accumulating changes |
| `/boomerang <task> Nx --converge` | Run up to N times, stop if no changes |
| `/boomerang /<template> [args]` | Run template and collapse |
| `/boomerang /a -> /b -> /c` | Chain templates |
| `/boomerang /a -> /b 3x` | Chain templates, loop 3 times |
| `/boomerang-cancel` | Abort without collapsing |
| `/boomerang anchor` | Set collapse point |
| `/boomerang anchor show` | Show anchor info |
| `/boomerang anchor clear` | Remove anchor |
| `/boomerang tool [on\|off]` | Enable/disable agent tool |
| `/boomerang guidance [text]` | Set/show/clear guidance |

## vs pi-context

[pi-context](https://github.com/ttttmr/pi-context) gives the agent Git-like tools to manage its own context—create milestones, monitor token usage, decide when to squash.

The problem: LLMs cut corners when told about resource limits. "You're at 80% capacity" triggers scarcity mindset—rushing, skipping exploration, shallower analysis.

pi-boomerang keeps the agent unaware. It sees the task, works thoroughly, collapse happens invisibly.

## Interaction with Rewind Extension

Independent. pi-boomerang collapses *context/tokens*. Rewind restores *files*. Use together: boomerang saves tokens, rewind fixes broken files.

## Limitations

- Summary is heuristic—extracts file operations from tool calls, may miss semantic details
- Agent might still ask questions despite instructions (boomerang completes anyway)
- Anchor state is in-memory only, clears on session start/switch
- Tool-initiated collapse may not update UI immediately (`/reload` to refresh)
