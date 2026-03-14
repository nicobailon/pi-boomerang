# Task for crew-planner

Create a task breakdown for implementing this PRD.

## PRD: /Users/nicobailon/Documents/docs/boomerang-loop-plan.md

# Boomerang Loop Feature - Implementation Plan

## Overview

Add looping capability to boomerang so users can run tasks multiple times with changes accumulating across iterations. Each iteration collapses back to an auto-managed anchor point, and the loop terminates early if an iteration produces no file changes (convergence detection).

**User command:**
```bash
/boomerang /deslop 5x                           # Template: 5 iterations
/boomerang /scout -> /impl 2x -- "task"        # Chain: 2 iterations with global args
/boomerang "improve code" 3x --converge        # Task: 3 iterations with convergence detection
```

## Architecture & Design

### 1. Command Syntax & Parsing

**Pattern:** `<task or chain> <count>x [--converge] [-- <global args...>]` [CORRECTED: chain syntax already uses `--` for global args, so loop parsing must account for it]

The loop count must be a suffix `Nx` where N is 1-999. Examples:
- `/boomerang /deslop 5x` → template "deslop", 5 iterations
- `/boomerang /scout -> /impl 2x -- "task"` → chain with 2 iterations, global args "task"
- `/boomerang "improve this" 10x` → raw task, 10 iterations
- `/boomerang /task 1x` → valid but pointless (same as no loop)

**Parser changes:**

Update the main handler to detect and extract loop count:

```typescript
function extractLoopCount(task: string): {
  task: string;        // task without loop metadata
  loopCount: number;   // 1-999
  converge: boolean;   // --converge flag present
} | null
```

This should:
1. Operate on the **raw string** with quote-aware boundary detection — not `parseCommandArgs()` followed by token-join, because naive reconstruction loses quote boundaries and breaks args containing spaces (e.g., `"fix auth bug"` becomes three tokens). [FIXED: parseCommandArgs strips quotes; rejoining tokens corrupts multi-word quoted args]
2. Split around the first standalone `--` so chain global args are preserved untouched
3. Parse loop count only from a standalone token matching `^\d{1,3}x$` in the **main command segment before `--`** (not from tokens like `fix5x`) [FIXED: avoids Nx parsing collisions]
4. Parse `--converge` only as command metadata in the main command segment, never from global args [FIXED: prevents false positives from template/global arguments]
5. Strip matched tokens from the raw string by character position (tracking quote state to find word boundaries), preserving all surrounding syntax verbatim [FIXED: string reconstruction must preserve original quoting, not re-quote from tokens]
6. **Ambiguity note:** A standalone `Nx` token is always consumed as a loop count even if the user intended it as a template arg (e.g., `/scale 3x`). This is an accepted tradeoff — users can quote it (`"3x"`) to pass it as an arg instead. [ADDED: documents the parsing ambiguity]

**Handler position:** `extractLoopCount` runs in the command handler **after** subcommand checks (anchor/tool/guidance), empty-input validation, and active/busy guards — but **before** `parseChain()` and template detection. This prevents loop tokens from being consumed as chain step args or template args. [ADDED: specifies exact insertion point in the command handler flow]

**Post-extraction validation:** After `extractLoopCount` succeeds, check that the remaining task string is non-empty (after trimming). If empty, show a usage error and return — e.g., `/boomerang 5x` or `/boomerang --converge 5x` would extract loop metadata but leave nothing to actually execute. The existing `if (!trimmed)` check runs on the *raw* input before extraction, so it doesn't catch this. [ADDED: without this, an empty task after extraction falls through to `pi.sendUserMessage("")`]

### 2. Loop State Machine

Add to the existing boomerang state:

```typescript
interface LoopState {
  loopCount: number;           // Total iterations to run
  currentIteration: number;     // 1-indexed: 1, 2, ..., loopCount
  stoppedEarly: boolean;        // Set to true if convergence triggered early exit [FIXED: renamed from `converged` to avoid confusion with `convergenceEnabled`]
  autoAnchorId: string;         // Fixed collapse target for this loop iteration set
  iterationSummaries: string[]; // Per-iteration summaries (individual, not accumulated)
  convergenceEnabled: boolean;  // Per-command opt-in from --converge [FIXED: renamed from `converge` — old name was one char from `converged`]
  baseTask: string;             // Original task/chain string without loop metadata (raw, quotes preserved)
  isChain: boolean;             // Whether baseTask should be parsed through parseChain/restartChainForLoop
  templateRef?: string;         // For template loops: the template ref (e.g., "deslop") [ADDED: needed for re-loading template + skill on subsequent iterations]
  templateArgs?: string[];      // For template loops: the parsed positional args [ADDED: needed for re-expanding template content]
  commandCtx: ExtensionCommandContext; // The original command context [ADDED: needed to re-invoke iteration execution]
  lastIterationHadChanges: boolean | null; // Set from session_before_tree entries
}

let loopState: LoopState | null = null;
// No global LoopConfig for convergence; convergence is command-scoped via --converge. [CORRECTED: existing extension has no loop config surface]
```

### 3. Execution Flow

**Initial state** (user runs `/boomerang /task 5x`):
1. Parse command, extract loopCount=5, task="/task"
2. Initialize loopState: { loopCount: 5, currentIteration: 1, stoppedEarly: false, autoAnchorId, iterationSummaries: [], convergenceEnabled, baseTask, isChain, templateRef, templateArgs, commandCtx, lastIterationHadChanges: null }
3. Set auto-anchor once at current leaf position (do not mutate `anchorEntryId`) [CORRECTED: user anchor and loop anchor must remain independent]
4. Execute iteration 1 of the task
5. Set `pendingCollapse.targetId = loopState.autoAnchorId` (collapse back to anchor)
6. Set status to "loop 1/5"
7. Keep existing active-task guard (`boomerangActive || chainState`) so `/boomerang ... Nx` is rejected while any boomerang run is active [ADDED: aligns with current command handler behavior]
8. Route loop collapses through the existing command path (`pendingCollapse` + `navigateTree`); do not alter tool-only `toolCollapsePending` / `branchWithSummary` fallback behavior [ADDED: preserves current command/tool separation]

**After iteration N completes** (in `agent_end` hook):
1. `session_before_tree` generates the iteration summary from `entriesToSummarize` and records `lastIterationHadChanges` via `didIterationMakeChanges(entries)` [CORRECTED: summary generation currently happens in `session_before_tree`, not `agent_end`]
2. `agent_end` reads the stored per-iteration summary/change signal after successful collapse and appends to `loopState.iterationSummaries` [CORRECTED: `agent_end` should orchestrate continuation, not re-parse entries]
3. **Reset per-iteration state only** — clear `pendingCollapse`, `lastTaskSummary`, `pendingSkill`, and `chainState`. Do NOT call `clearTaskState()` (which would also clear `previousModel`, `previousThinking`, and `boomerangActive`). Do NOT call `restoreModelAndThinking()`. [ADDED: explicit field-by-field partition — implementers must know exactly which fields survive between iterations]
4. Check if we should continue:
   - If currentIteration === loopCount → stop (all done)
   - If `loopState.convergenceEnabled` && `lastIterationHadChanges === false` → stop (converged) [FIXED: convergence must use tool-call entries, not summary text]
   - Otherwise → increment currentIteration, call `executeLoopIteration()` (see below)

**`executeLoopIteration()` — the per-iteration dispatch function:** [ADDED: the plan previously had no concrete function for re-executing iterations; this is required because templates need re-loading and skills need re-injection each iteration]

This function is called for every iteration (including the first). It reads `loopState` to determine what to execute:

```
if loopState.isChain:
  1. Re-parse loopState.baseTask through parseChain()
  2. Call restartChainForLoop() — NOT handleChain(). This is
     required for ALL iterations including iteration 1, because
     handleChain() computes targetId as `anchorEntryId ?? startEntryId`
     (line ~425 in index.ts). With a pre-existing user anchor, that
     would target anchorEntryId instead of loopState.autoAnchorId,
     causing iterations to collapse to different targets.
     [FIXED: section 8 previously said "call handleChain() normally"
     for iteration 1, contradicting the target override requirement]
  3. restartChainForLoop re-resolves templates, creates fresh chainState
     with targetId = loopState.autoAnchorId, and calls executeChainStep().
     It does NOT save previousModel/previousThinking (the loop init
     already did that). Model/thinking switching is handled per-step
     by executeChainStep's existing logic.

if loopState.templateRef is set:
  1. Re-load template from file via loadTemplate(loopState.templateRef, cwd)
  2. Switch model if template specifies one: call resolveAndSwitchModel().
     On iteration 1 this performs the actual switch; on iterations 2+
     it returns alreadyActive:true (idempotent no-op).
     [FIXED: pseudocode was missing model switching — iteration 1
     would have run on the original model instead of the template's]
  3. Switch thinking level if template specifies one and it differs
     from current: call pi.setThinkingLevel(). Same idempotent
     pattern as model switching.
     [FIXED: pseudocode was also missing thinking level switching]
  4. Re-substitute args: substituteArgs(template.content, loopState.templateArgs)
  5. Re-load skill into pendingSkill if template.skill is set
     [ADDED: pendingSkill is consumed (set to null) by before_agent_start
     after first use — must be re-set before each iteration]
  6. Set pendingCollapse = { targetId: loopState.autoAnchorId, task,
     commandCtx, switchedToModel, switchedToThinking, injectedSkill }
  7. Call pi.sendUserMessage(expandedContent)

else (plain task):
  1. Set pendingCollapse = { targetId: loopState.autoAnchorId, task: loopState.baseTask, commandCtx }
  2. Call pi.sendUserMessage(loopState.baseTask)
```

**After final iteration**:
1. Clear loopState
2. Clear auto-anchor
3. Restore model/thinking once for the overall loop (same timing as current boomerang completion) [CORRECTED: existing code restores in completion/cancel paths, not per step]
4. Call `clearTaskState()` to reset remaining per-task fields
5. Update status to show completion
6. Show summary info (e.g., "Loop completed: 5/5 iterations, converged at iteration 3")

### 3b. Loop-Aware System Prompt

[ADDED: the plan had no mention of modifying BOOMERANG_INSTRUCTIONS for loops — the agent needs to know it's in a loop so it builds on previous iterations rather than starting from scratch each time]

When `loopState` is active, `before_agent_start` should append loop context after BOOMERANG_INSTRUCTIONS:

```
LOOP ITERATION 3/5
You are on iteration 3 of 5 in a loop. Previous iterations made changes
that are already applied to the codebase. Build on that work — do not
repeat what was already done. Focus on what remains to improve.
```

This is critical for the feature's value proposition: each iteration should make *incremental* progress, not re-do previous work. Without this prompt, the agent treats each iteration as independent and may repeat the same changes.

### 4. Summary Generation for Loops

Modify `generateSummaryFromEntries()` to accept loop info:

```typescript
function generateSummaryFromEntries(
  entries: SessionEntry[],
  task: string,
  config?: SummaryConfig,
  loopInfo?: {
    iteration: number;
    totalIterations: number;
    converged?: boolean;
  }
): string
```

Output format for loop iteration:
```
[BOOMERANG COMPLETE - LOOP 1/5]
Task: "/deslop"
Actions: read 3 file(s), modified src/main.ts
Outcome: Removed unnecessary code blocks...

---

[BOOMERANG COMPLETE - LOOP 2/5]
Task: "/deslop"
Actions: read 2 file(s), modified src/utils.ts
Outcome: Further simplified utility functions...

[BOOMERANG COMPLETE - LOOP 3/5]
Task: "/deslop"
Actions: no modifications
Outcome: Task converged (no further improvements).
```

**Convergence detection logic:**
```typescript
function didIterationMakeChanges(entries: SessionEntry[]): boolean {
  // Parse entries for write/edit tool calls
  // Return true if any file was modified
  // Return false if only reads or no tool calls
}
```
[ADDED: run this in `session_before_tree` on `event.preparation.entriesToSummarize` so convergence and summary are derived from the same entry slice]

### 5. Integration with Anchor System

When loop ends:
- If user had pre-set anchor: leave it alone, loop only uses auto-anchor
- If loop set auto-anchor: clear it after loop completes
- Summaries accumulate at the loop auto-anchor via loop-owned accumulation, not `anchorSummaries` [CORRECTED: existing `anchorSummaries` only accumulates when `targetId === anchorEntryId`]

The `session_before_tree` hook already handles user-anchor accumulation via the `anchorEntryId !== null && targetId === anchorEntryId` check. Loop accumulation needs a **parallel check**: `loopState !== null && targetId === loopState.autoAnchorId`. When this is true, join `[...loopState.iterationSummaries, currentIterationSummary]` as the `finalSummary`. [FIXED: current plan incorrectly assumed automatic accumulation]

**Precedence when both checks match:** If the user sets an anchor at position X and then immediately starts a loop (no intervening messages), `autoAnchorId === anchorEntryId` — both checks are true. **Loop must win.** Use `if/else` ordering: check loop first, else check user-anchor, else raw summary. The same precedence applies in `agent_end`'s post-collapse accumulator push: if `loopState` is active, push to `loopState.iterationSummaries` only, do NOT also push to `anchorSummaries`. [ADDED: without explicit precedence, the overlap case would double-accumulate or produce wrong summary shape]

Note: each `navigateTree` call to the auto-anchor creates a **new branch** from that anchor. The previous branch (with old accumulated summary) becomes a sibling. So iteration N+1's context includes only the latest accumulated summary entry (type `"branch_summary"`, filtered by `generateSummaryFromEntries`'s `entry.type !== "message"` check) plus the new user message and assistant responses. This means `generateSummaryFromEntries` correctly processes only the current iteration's assistant entries, not previous iterations'. [ADDED: explains why the entry filtering works correctly across iterations]

### 6. State Management & Cleanup

Add cleanup cases:
- `session_start` → clear loopState (via `clearState()`)
- `session_switch` → clear loopState (via `clearState()`)
- `/boomerang-cancel` → clear loopState, and prevent `agent_end` from queuing another iteration. Since `boomerang-cancel` calls `restoreModelAndThinking()` then `clearTaskState()`, and both loopState and task state need clearing, add `loopState = null` to the cancel handler explicitly. [ADDED: handles mid-iteration cancel safely]
- Boomerang completion → clear loopState only after final iteration (but not user-set anchor) [FIXED: loop state must survive between iterations]

**Field survival between loop iterations** (critical implementation detail): [ADDED: the plan said "coordinate clearTaskState" without specifying which fields live and die]

| Field | Between iterations | After final / cancel |
|---|---|---|
| `boomerangActive` | **KEEP** (true) | Clear (false) |
| `pendingCollapse` | Clear (re-set by `executeLoopIteration`) | Clear |
| `lastTaskSummary` | Clear (re-set by `session_before_tree`) | Clear |
| `pendingSkill` | Clear (re-set by `executeLoopIteration`) | Clear |
| `previousModel` | **KEEP** (points to original) | Consumed by `restoreModelAndThinking()` |
| `previousThinking` | **KEEP** (points to original) | Consumed by `restoreModelAndThinking()` |
| `chainState` | Clear (re-created by `restartChainForLoop` if chain loop) | Clear |
| `loopState` | **KEEP** | Clear |

Do NOT call `clearTaskState()` between iterations — it would wipe `previousModel`, `previousThinking`, and `boomerangActive`. Instead, clear only the per-iteration fields listed above. After the final iteration or cancel, call the full `restoreModelAndThinking()` → `clearTaskState()` → `loopState = null` sequence.

### 7. UI/Status Indicators

**During loop:**
```
🔄 loop 1/5
🔄 loop 2/5
...
```

**After completion:**
```
✓ Loop completed: 5/5 iterations
  or
✓ Loop converged: 3/5 iterations (stopped early - no changes)
```

Reuse existing `updateStatus()` logic:
```typescript
if (loopState && chainState) {
  // e.g. "loop 2/5 · chain 1/3"
} else if (loopState) {
  ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", `loop ${loopState.currentIteration}/${loopState.loopCount}`));
}
```
[ADDED: chain progress currently has status precedence; loop+chain needs an explicit combined status path]

### 8. Chain + Loop Interaction

Users can combine chains with loops:
```bash
/boomerang /scout -> /impl 2x -- "task"
```

This should:
1. Run scout step → impl step → collapse (iteration 1)
2. Run scout step → impl step → collapse (iteration 2)

**Implementation:** Keep `handleChain()` responsible for a single chain execution; orchestrate loop restarts from `agent_end` using stored loop metadata. [CORRECTED: wrapping directly inside `handleChain()` conflicts with current `chainState`/collapse lifecycle]

- **All iterations (including iteration 1):** use `restartChainForLoop()`, never `handleChain()` directly. `handleChain()` has two problems for loop use: (1) it computes `targetId = anchorEntryId ?? startEntryId` which ignores `autoAnchorId` when the user has a pre-set anchor, and (2) it calls `clearTaskState()` then re-saves `previousModel = ctx.model` which would corrupt the original model reference on iterations 2+. [FIXED: section previously said "call handleChain() normally" for iteration 1, which causes target mismatch when user anchor exists]
- `restartChainForLoop()` re-parses `loopState.baseTask` through `parseChain()`, resolves templates, creates fresh `chainState` with `targetId = loopState.autoAnchorId`, and calls `executeChainStep()`. It does NOT save `previousModel`/`previousThinking` — those were saved once in the loop init.
- Model saving (`previousModel = ctx.model`, `previousThinking = pi.getThinkingLevel()`) happens **once** in the command handler's loop init, before `executeLoopIteration()` is called for the first time.

Key: Keep chain and loop state separate. Loop wraps the entire chain. `previousModel`/`previousThinking` are set once at loop start and consumed once at loop end.

## Code Changes Required

### File: `index.ts`

**New types:**
```typescript
interface LoopState {
  loopCount: number;
  currentIteration: number;
  stoppedEarly: boolean;
  autoAnchorId: string;
  iterationSummaries: string[];
  convergenceEnabled: boolean;
  baseTask: string;
  isChain: boolean;
  templateRef?: string;
  templateArgs?: string[];
  commandCtx: ExtensionCommandContext;
  lastIterationHadChanges: boolean | null;
}
```
[CORRECTED: aligned with verified loop-state requirements — renamed converge/converged, added templateRef/templateArgs/commandCtx]

**New functions:**
- `extractLoopCount(task: string)` → quote-aware raw-string parser, returns `{ task, loopCount, converge }` or null
- `executeLoopIteration(ctx)` → dispatches iteration N: re-loads template + skill (if template loop), re-parses chain (if chain loop), or re-sends plain task; sets pendingCollapse targeting autoAnchorId [ADDED: this was the critical missing function]
- `restartChainForLoop(ctx)` → re-resolves templates from baseTask, creates fresh chainState without touching previousModel/previousThinking [ADDED: needed for chain+loop to avoid model-save corruption]
- `didIterationMakeChanges(entries: SessionEntry[])` → convergence check (write/edit tool calls only)

**Modified functions:**
- `boomerang` command handler → extract loop count (after subcommand/validation checks, before parseChain), set auto-anchor, call `executeLoopIteration` for first iteration
- `agent_end` hook → handle iteration transitions: reset per-iteration fields (NOT clearTaskState), check convergence, call `executeLoopIteration` or finalize loop
- `before_agent_start` hook → append loop iteration context to system prompt when loopState is active [ADDED: agent needs to know iteration N/M]
- `session_before_tree` hook → pass loopInfo to summary generator, compute/stash `lastIterationHadChanges`, handle loop-owned summary accumulation [FIXED: convergence signal source is this hook]
- `generateSummaryFromEntries()` → accept loopInfo parameter for `[BOOMERANG COMPLETE - LOOP N/M]` header
- `updateStatus()` → show "loop X/N", combined "loop X/N · chain Y/Z" when both active
- `clearState()` → also clear loopState
- `boomerang-cancel` handler → add explicit `loopState = null` (clearTaskState doesn't cover it)

**New state variables:**
```typescript
let loopState: LoopState | null = null;
```

## Testing Strategy

**Unit tests (vitest):**

1. **Parsing:**
   - `extractLoopCount("/task 5x")` → { task: "/task", loopCount: 5, converge: false }
   - `extractLoopCount("/a -> /b 2x -- \"task\"")` → { task: "/a -> /b -- \"task\"", loopCount: 2, converge: false } [CORRECTED: verify chain/global-arg reconstruction]
   - `extractLoopCount("/task 5x --converge")` → { task: "/task", loopCount: 5, converge: true }
   - Rejects invalid: "task 0x", "task 1000x", "task x5"
   - Does not parse loop from non-standalone suffixes: "/task fix5x" [ADDED: avoids Nx collision]
   - Does not parse `--converge` from global args segment after `--` [ADDED: avoids metadata/arg conflict]

2. **Convergence detection:**
   - `didIterationMakeChanges(entries)` with edit calls → true
   - `didIterationMakeChanges(entries)` with only reads → false
   - `didIterationMakeChanges([])` → false

3. **Loop execution:**
   - Loop runs exactly N times when no convergence
   - Loop stops early at iteration M < N when converged
   - Auto-anchor is set at start and cleared at end
   - Each iteration collapses to auto-anchor
   - Summaries accumulate at loop auto-anchor even when user anchor exists [FIXED: existing anchor accumulation is user-anchor-only]
   - When user anchor and auto-anchor are the same entry ID, loop accumulation takes precedence (no double-push to `anchorSummaries`) [ADDED: covers the overlap edge case from section 5]
   - `/boomerang-cancel` during an active iteration prevents additional iterations from being scheduled [ADDED: mid-iteration cancel edge case]
   - Model/thinking restore occurs once when loop fully completes or is canceled (not per iteration) [ADDED: matches existing restoration pattern]

4. **Chain + loop:**
   - Chain runs complete N times with all steps
   - Each chain iteration collapses to the loop auto-anchor and then restarts from iteration state
   - Status shows loop progress and chain step progress together when both are active [CORRECTED: current status has chain precedence]
   - Tool-initiated collapse path (`toolAnchorEntryId` / `toolCollapsePending`) remains unaffected by loop state [ADDED: avoid regressions in existing tool flow]

5. **State cleanup:**
   - loopState clears on session_start
   - loopState clears on session_switch
   - loopState clears on /boomerang-cancel
   - Auto-anchor clears with loopState
   - `previousModel`/`previousThinking`/`boomerangActive` survive between iterations

6. **Iteration re-execution:** [ADDED: these test cases were missing entirely]
   - Template loops: skill is re-injected via `pendingSkill` on every iteration (not just iteration 1)
   - Template loops: template content is re-loaded and re-expanded each iteration
   - `before_agent_start` appends BOOMERANG_INSTRUCTIONS + loop iteration context on every iteration
   - `session_before_tree` accumulates per-iteration summaries via `loopState.iterationSummaries` (not `anchorSummaries`)
   - `session_before_tree` produces correct accumulated `finalSummary` for iteration N (contains summaries 1..N)
   - `generateSummaryFromEntries` only processes current iteration's assistant entries (previous iteration's branch_summary entries are filtered by `entry.type !== "message"`)

7. **Chain + loop convergence:** [ADDED: convergence for chain loops was unspecified]
   - Convergence checks the **entire chain iteration's** entries (all steps), not just the last step
   - If scout reads files and impl makes no changes, iteration converges (impl is the relevant signal)
   - `extractLoopCount` correctly quotes args containing spaces when ambiguous: `/task "3x"` passes `3x` as an arg, not a loop count

## Future Enhancements

1. **Conditional continuation:** Allow agent to return a "stop reason" to exit early
2. **Max time limit:** `--timeout 5m` to bound loop execution time
3. **Custom convergence:** Allow task to define what counts as "converged"
4. **Loop reporting:** `/boomerang last-loop` to show report of last loop
5. **Iteration branching:** Option to branch each iteration instead of collapsing (preserve full history)

## Rollout Plan

1. **Phase 1:** Core loop with fixed iterations + convergence detection
2. **Phase 2:** Better UI/progress indication, documentation
3. **Phase 3:** Feed back into real-world usage, gather patterns
4. **Phase 4:** Conditional termination, timeout, reporting features


## Available Skills

Workers can load these skills on demand during task execution. When creating tasks, you may include a `skills` array with relevant skill names to help workers prioritize which to read.

  agent-reflection — Manage the agent-reflection knowledge system on Mac mini. Includes Twitter/GitHub/YouTube sync, API server, CLI tools. Use when working with the knowledge base, fixing sync issues, or checking data pipelines. ALWAYS work from Mac mini remote, not MacBook.
  building-tuis-with-charm — >-
  chrome-devtools — Browser automation, debugging, and performance analysis using Puppeteer CLI scripts. Use for automating browsers, taking screenshots, analyzing performance, monitoring network traffic, web scraping, form automation, and JavaScript debugging.
  claude-cli — Claude Code CLI reference. Use when running claude in interactive_shell overlay or when user asks about claude CLI options.
  clean-copy — Reimplement a branch with a clean, narrative-quality commit history. Use when the user wants to clean up messy commits, create a reviewable PR, or rewrite history as a tutorial-style sequence. Creates a new branch, does not modify the source.
  cloudflare — Comprehensive Cloudflare platform skill covering Workers, Pages, storage (KV, D1, R2), AI (Workers AI, Vectorize, Agents SDK), networking (Tunnel, Spectrum), security (WAF, DDoS), and infrastructure-as-code (Terraform, Pulumi). Use for any Cloudflare development task.
  code-mode — Batch multiple tool operations into a single JavaScript execution. Use when a task requires multiple file reads, writes, edits, or bash commands that can be chained together to reduce round-trips and save tokens.
  code-simplifier — Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Focuses on recently modified code unless instructed otherwise.
  codex-5-3-prompting — How to write system prompts and instructions for GPT-5.3-Codex. Use when constructing or tuning prompts targeting Codex 5.3.
  codex-cli — OpenAI Codex CLI reference. Use when running codex in interactive_shell overlay or when user asks about codex CLI options.
  coordination — Multi-agent coordination for parallel plan execution with the coordinate and coord_output tools.
  crafting-readme-files — >-
  cursor-cli — Cursor Agent CLI reference. Use when running cursor agent in interactive_shell overlay or when user asks about cursor CLI options.
  design-deck — Present visual options for architecture, UI, and code decisions with high-fidelity side-by-side previews. For comparing approaches visually — code diffs, diagrams, UI mockups, images — not for gathering structured input (use interview for that). Supports previewBlocks (code, mermaid, image, html), previewHtml, generate-more loops, and plan/PRD-driven flows.
  extension-dev — Develop extensions for pi agent. Includes tips, gotchas, and patterns learned from building real extensions. Use when creating or modifying pi extensions, hooks, or TUI components.
  foreground-chains — Orchestrate multi-agent workflows where users watch each step in the overlay. Uses different CLI agents (cursor, pi, codex) for specialized roles with file-based handoff and auto-continue support for agents that pause mid-task.
  frontend-design — Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.
  gemini-cli — Gemini CLI reference. Use when running gemini in interactive_shell overlay or when user asks about gemini CLI options.
  gpt-5-4-prompting — How to write system prompts and instructions for GPT-5.4. Use when constructing or tuning prompts targeting GPT-5.4.
  llms-blog — Create and manage AI-friendly blogs with llms.txt support. Use when the user asks to create a blog, set up a blog, deploy a blog, or manage blog posts via the llms-blog CLI.
  macmini-remote — SSH into Mac mini via Tailscale for remote development. Run commands, manage tmux sessions, git worktrees. Use when user asks to work on the mini, run something remotely, or check the mini.
  media-download — Download videos and media from social platforms (Instagram, YouTube, Twitter/X, TikTok, etc.) using yt-dlp. Use when user asks to download, save, or grab a video/media from a URL.
  media-processing — Process multimedia files with FFmpeg (video/audio encoding, conversion, streaming, filtering, hardware acceleration) and ImageMagick (image manipulation, format conversion, batch processing, effects, composition). Use when converting media formats, encoding videos with specific codecs (H.264, H.265, VP9), resizing/cropping images, extracting audio from video, applying filters and effects, optimizing file sizes, creating streaming manifests (HLS/DASH), generating thumbnails, batch processing images, creating composite images, implementing media processing pipelines, or creating animated WebP clips for README demos and documentation. Supports 100+ formats, hardware acceleration (NVENC, QSV), and complex filtergraphs.
  parallel-scout — Investigate multiple questions in parallel using async scout subagents. Use when you need to research several independent questions against a codebase simultaneously, then synthesize the findings.
  pi-cli — Pi coding agent CLI reference. Use when running pi in interactive_shell overlay, spawning pi subagents, or when user asks about pi CLI options.
  pi-messenger-crew — Use pi-messenger for multi-agent coordination and Crew task orchestration. Covers joining the mesh, planning from PRDs, working on tasks, file reservations, and agent messaging. Load this skill when using pi_messenger or building with Crew.
  plan-mode — Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a <proposed_plan> block.
  prompt-templates — Create and manage custom slash commands (prompt templates) for pi agent. Use when user asks to create a slash command, make a custom prompt, add a /command, write a prompt template, or wants reusable prompts. Also known as "slash commands" in Claude Code.
  react-best-practices — React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimization, or performance improvements.
  react-native-best-practices — Provides React Native performance optimization guidelines for FPS, TTI, bundle size, memory leaks, re-renders, and animations. Applies to tasks involving Hermes optimization, JS thread blocking, bridge overhead, FlashList, native modules, or debugging jank and frame drops.
  remotion-best-practices — Best practices for Remotion - Video creation in React
  safe-bash — Prevents bash commands from hanging by avoiding interactive commands, editors, pagers, REPLs, and prompts. Load this skill when running bash commands to ensure non-interactive execution patterns.
  shopify — Build Shopify applications, extensions, and themes using GraphQL/REST APIs, Shopify CLI, Polaris UI components, and Liquid templating. Capabilities include app development with OAuth authentication, checkout UI extensions for customizing checkout flow, admin UI extensions for dashboard integration, POS extensions for retail, theme development with Liquid, webhook management, billing API integration, product/order/customer management. Use when building Shopify apps, implementing checkout customizations, creating admin interfaces, developing themes, integrating payment processing, managing store data via APIs, or extending Shopify functionality.
  skill-creator — Guide for creating effective skills for pi coding agent. Use when users want to create a new skill or update an existing skill that extends pi's capabilities with specialized knowledge, workflows, or tool integrations.
  subagents — Delegate tasks to specialized subagents with chains, parallel execution, and async support. Use for task decomposition (scout → worker → reviewer), parallel information gathering, or isolated agent configurations.
  summarize — Summarize web pages and YouTube videos via LLM. Extracts clean text from URLs, fetches YouTube transcripts, and generates summaries. Use when user shares a URL to understand, asks to summarize a link, or needs content extracted from websites/videos.
  surf — Control Chrome browser via CLI for testing, automation, and debugging. Use when the user needs browser automation, screenshots, form filling, page inspection, network/CPU emulation, DevTools streaming, or AI queries via ChatGPT/Gemini/Perplexity/Grok/AI Studio.
  threejs — Build 3D web apps with Three.js (WebGL/WebGPU). Use for 3D scenes, animations, custom shaders, PBR materials, VR/XR experiences, games, data visualizations, product configurators.
  tmux — Remote control tmux sessions for interactive CLIs (pi agents, python, gdb, psql, etc.) by sending keystrokes and scraping pane output.
  vercel-deploy — Deploy applications and websites to Vercel. Use this skill when the user requests deployment actions such as "Deploy my app", "Deploy this to production", "Create a preview deployment", "Deploy and give me the link", or "Push this live". No authentication required - returns preview URL and claimable deployment link.
  video-edit — Edit video files using ffmpeg. Speed up/slow down, convert formats, trim, resize, extract audio, add/remove audio tracks. Use when user asks to edit, convert, speed up, trim, or modify a video file.
  visual-explainer — Generate beautiful, self-contained HTML pages that visually explain systems, code changes, plans, and data. Use when the user asks for a diagram, architecture overview, diff review, plan review, project recap, comparison table, or any visual explanation of technical concepts. Also use proactively when you are about to render a complex ASCII table (4+ rows or 3+ columns) — present it as a styled HTML page instead.
  web-design-guidelines — Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".


You must follow this sequence strictly:
1) Understand the PRD
2) Review relevant code/docs/reference resources
3) Produce sequential implementation steps
4) Produce a parallel task graph

Return output in this exact section order and headings:
## 1. PRD Understanding Summary
## 2. Relevant Code/Docs/Resources Reviewed
## 3. Sequential Implementation Steps
## 4. Parallelized Task Graph

In section 4, include both:
- markdown task breakdown
- a `tasks-json` fenced block with task objects containing title, description, dependsOn, and optionally skills (array of skill names from the Available Skills list that are relevant to the task).