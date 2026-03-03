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
Result: Read 10 file(s), modified src/auth.ts, src/login.ts, ran 3 command(s).
```

Same outcome. Fraction of the tokens. The session tree preserves full history for `/tree` navigation if you need it.

An inverted [D-Mail](https://steins-gate.fandom.com/wiki/D-Mail): where D-Mail rewrites reality while the observer remembers, boomerang rewrites the observer while reality persists. The session tree is your Reading Steiner.

## Install

```bash
pi install npm:pi-boomerang
```

Then restart pi to load the extension.

## Quick Start

```bash
# Autonomous task execution
/boomerang Refactor the auth module to use JWT

# Cancel mid-task (no context collapse)
/boomerang-cancel

# Set an anchor for batch work
/boomerang anchor

# Inspect or clear the anchor
/boomerang anchor show
/boomerang anchor clear
```

The agent works without asking questions, making reasonable assumptions. When complete, the extension collapses the work into a summary branch.

## How It Works

```
1. /boomerang <task>           → Records current entry ID, sends task
2. before_agent_start          → Injects autonomous mode instructions
3. Agent works                 → Multiple LLM calls, tool use, no interruptions
4. agent_end                   → Generates summary, calls navigateTree()
5. Session branches            → Work preserved in tree, summary branch active
```

The collapse uses `navigateTree()`, the same mechanism as `/tree`. The work is preserved in the session tree and can be accessed via `/tree`.

### Anchor Mode (Optional)

Without an anchor, each `/boomerang <task>` is self-contained—collapses just its own work to the entry right before the task started.

Set an anchor when you want multiple tasks to share the same collapse point:

```
1. /boomerang anchor           → Records the current entry as anchor
2. /boomerang <task A>         → Branches to anchor with summary A
3. /boomerang <task B>         → Branches to anchor with summaries A + B
4. /boomerang anchor show      → Shows anchor info and task count
5. /boomerang anchor clear     → Removes the anchor
```

Summaries accumulate, so each subsequent task's context includes what came before.

## Commands

**Task execution:**
- `/boomerang <task>` — Execute autonomously, then collapse
- `/boomerang-cancel` — Abort without collapsing

**Anchor management:**
- `/boomerang anchor` — Set collapse point
- `/boomerang anchor show` — Show info
- `/boomerang anchor clear` — Remove anchor

## Status Indicator

The footer shows boomerang state:

- **anchor** (cyan) — Anchor set, waiting for the next boomerang
- **boomerang** (yellow) — Active, agent working autonomously

## Summary Format

The heuristic summary extracts file operations from tool calls:

```
[BOOMERANG COMPLETE]
Task: "Fix the login bug"
Result: Read 3 file(s), modified src/auth.ts, src/login.ts, ran 2 command(s).
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No task provided | Error: "Usage: /boomerang <task> \| anchor [clear\|show]" |
| Already in boomerang | Error: "Boomerang already active" |
| Agent busy | Error: "Wait for completion first" |
| Agent asks question anyway | Boomerang completes, branches with partial summary |
| Cancel mid-task | Task cleared, no branch created; anchor preserved if set |
| Error/abort during task | Boomerang completes with partial summary |

## Accessing Collapsed Work

The work isn't deleted—it's preserved in the session tree. Use `/tree` to navigate back to the full work history if needed.

## Interaction with Rewind Extension

Independent. They solve different problems:

- **pi-boomerang** — Collapses *context/tokens* (branches to summary)
- **Rewind** — Restores *files* (git worktree state)

Use together: pi-boomerang collapses conversation tokens, rewind restores files if the agent broke something.

## vs pi-context

[pi-context](https://github.com/ttttmr/pi-context) takes a different approach: give the agent Git-like tools (`context_tag`, `context_log`, `context_checkout`) to manage its own context. The agent creates milestones, monitors token usage, decides when to squash.

The problem: LLMs cut corners when told about resource limits. "You're at 80% capacity" triggers scarcity mindset—rushing, skipping exploration, shallower analysis. The agent optimizes for efficiency over quality.

pi-boomerang keeps the agent unaware. It sees the task, works thoroughly, collapse happens invisibly. Even anchor mode doesn't leak—the agent does each task without knowing it's part of a batch.

## Agent-Callable Tool

The extension also registers a `boomerang` tool that agents can call directly for self-managed context collapse:

```
1. Agent calls boomerang()     → Sets anchor at current position
2. Agent does work             → Multiple tool calls, file operations
3. Agent calls boomerang()     → Triggers collapse from anchor
```

This is useful when an agent wants to manage its own context without user intervention.

**Important limitation:** When triggered via the tool, the chat history may not visually update immediately. The context IS collapsed (the agent sees the collapsed state on subsequent turns), but the UI continues showing the old messages until you run `/reload` or start a new session.

This happens because:
- The `/boomerang` command has access to `navigateTree()` which updates both the session tree AND the UI
- The tool only has access to `branchWithSummary()` which updates the tree but not the UI
- If you've run any `/boomerang` command previously in the session, the tool can borrow that context and get full UI updates

The tool is also disabled during an active command boomerang to prevent conflicts.

## Limitations

- Summary is heuristic—extracts file operations from tool calls, may miss semantic details
- Agent might still ask questions despite instructions (boomerang completes anyway)
- Anchor state is in-memory only and clears on session start/switch
- Tool-initiated collapse may not update UI immediately (use `/reload` to refresh)
