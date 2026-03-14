# Wire loop into command handler and agent_end hook

## Context

This is the final wiring task. Integrate loop extraction into the command handler and loop iteration management into agent_end.

Read the full plan at ~/Documents/docs/boomerang-loop-plan.md (sections 1, 3, 5, 6, 8) and the FULL codebase at index.ts and index.test.ts before writing any code. By this point, task-1 through task-4 have added: `extractLoopCount`, `didIterationMakeChanges`, `LoopState`, `loopState` variable, updated `clearState`/cancel/`updateStatus`, `generateSummaryFromEntries` with loopInfo, loop-aware `session_before_tree`, `executeLoopIteration`, `restartChainForLoop`, and loop-aware `before_agent_start`.

## 1. Command Handler: Loop Extraction

In the `boomerang` command handler, **after** the active/busy guards and **before** `parseChain()`:

```typescript
// Extract loop count (must run before parseChain to prevent Nx being consumed as chain arg)
const loopExtract = extractLoopCount(trimmed);
if (loopExtract) {
  if (!loopExtract.task.trim()) {
    ctx.ui.notify("Usage: /boomerang <task> Nx [--converge]", "error");
    return;
  }
  // Continue with loopExtract.task as the task to execute
}
const effectiveTask = loopExtract ? loopExtract.task : trimmed;
```

Then use `effectiveTask` instead of `trimmed` for all downstream parsing (parseChain, template detection, plain task).

## 2. Command Handler: Loop Initialization

When `loopExtract` is non-null, after determining the task type (chain/template/plain) but before executing:

```typescript
const startEntryId = ctx.sessionManager.getLeafId();
if (!startEntryId) {
  ctx.ui.notify("No session entry to start from", "error");
  return;
}

// Determine task type
const isChain = parseChain(effectiveTask) !== null;
const isTemplate = effectiveTask.startsWith("/");

// Parse template ref and args if template
let templateRef: string | undefined;
let templateArgs: string[] | undefined;
if (isTemplate && !isChain) {
  const spaceIndex = effectiveTask.indexOf(" ");
  templateRef = spaceIndex > 0 ? effectiveTask.slice(1, spaceIndex) : effectiveTask.slice(1);
  const rawArgs = spaceIndex > 0 ? effectiveTask.slice(spaceIndex + 1) : "";
  templateArgs = parseCommandArgs(rawArgs);
}

// Save model/thinking BEFORE any switching
previousModel = ctx.model;
previousThinking = pi.getThinkingLevel();

// Clear orphaned tool state
toolAnchorEntryId = null;
toolCollapsePending = false;

// Initialize loop state
loopState = {
  loopCount: loopExtract.loopCount,
  currentIteration: 1,
  stoppedEarly: false,
  autoAnchorId: startEntryId,
  iterationSummaries: [],
  convergenceEnabled: loopExtract.converge,
  baseTask: effectiveTask,
  isChain,
  templateRef,
  templateArgs,
  commandCtx: ctx,
  lastIterationHadChanges: null,
};

boomerangActive = true;
updateStatus(ctx);
ctx.ui.notify(`Loop started: ${loopExtract.loopCount} iterations`, "info");

// Execute first iteration
await executeLoopIteration(ctx);
return;
```

This replaces the normal template/chain/plain-task dispatch when a loop is detected. The existing non-loop paths remain untouched.

## 3. agent_end Hook: Loop Iteration Management

In the `agent_end` hook, **after** the existing chain-step advancement block and **after** the navigateTree collapse for command-initiated boomerangs, add loop continuation logic.

The exact insertion point is after the successful collapse in the main boomerang block:

```typescript
// After successful navigateTree collapse:
if (!result.cancelled) {
  // Loop accumulation (precedence: loop > user-anchor)
  if (loopState && lastTaskSummary) {
    loopState.iterationSummaries.push(lastTaskSummary);
  } else if (anchorEntryId !== null && targetId === anchorEntryId && lastTaskSummary) {
    anchorSummaries.push(lastTaskSummary);
  }
  ctx.ui.notify("Boomerang complete. Context collapsed.", "info");
}

// Loop continuation check
if (loopState) {
  const shouldStop =
    loopState.currentIteration >= loopState.loopCount ||
    (loopState.convergenceEnabled && loopState.lastIterationHadChanges === false);

  if (shouldStop) {
    if (loopState.convergenceEnabled && loopState.lastIterationHadChanges === false) {
      loopState.stoppedEarly = true;
      ctx.ui.notify(
        `Loop converged at iteration ${loopState.currentIteration}/${loopState.loopCount} (no changes detected)`,
        "info"
      );
    } else {
      ctx.ui.notify(
        `Loop completed: ${loopState.currentIteration}/${loopState.loopCount} iterations`,
        "info"
      );
    }
    // Fall through to normal cleanup below
    loopState = null;
  } else {
    // Continue to next iteration
    loopState.currentIteration++;
    // Reset per-iteration state (NOT clearTaskState — that would wipe previousModel etc.)
    pendingCollapse = null;
    lastTaskSummary = null;
    pendingSkill = null;
    chainState = null;
    loopState.lastIterationHadChanges = null;

    updateStatus(ctx);
    await executeLoopIteration(ctx);
    return; // Don't fall through to cleanup!
  }
}

// Existing cleanup (runs for non-loop boomerangs and final loop iteration)
await restoreModelAndThinking(ctx);
clearTaskState();
updateStatus(ctx);
```

**Key details:**
- The `return` after `executeLoopIteration()` prevents falling through to the cleanup block.
- `loopState = null` before the fall-through ensures cleanup wipes everything.
- Per-iteration reset clears exactly: `pendingCollapse`, `lastTaskSummary`, `pendingSkill`, `chainState`, `lastIterationHadChanges`. Does NOT clear: `boomerangActive`, `previousModel`, `previousThinking`, `loopState`.
- The accumulation uses if/else precedence: loop first, user-anchor second (handles overlap case where both IDs match).

## 4. Tests

**Command handler:**
- `/boomerang /task 5x` initializes loopState with correct fields
- `/boomerang /scout -> /impl 2x -- "args"` sets isChain=true, baseTask correctly
- `/boomerang "plain task" 3x` sets isChain=false, templateRef=undefined
- `/boomerang 5x` shows usage error (empty task after extraction)
- `/boomerang /task 5x` while boomerang active → "already active" error
- Non-loop command `/boomerang /task` still works (regression)

**agent_end loop transitions:**
- 3-iteration loop: agent_end fires 3 times, sends 3 messages, navigateTree called 3 times
- Each iteration collapses to autoAnchorId
- After final iteration: restoreModelAndThinking is called, loopState is null
- Between iterations: previousModel/previousThinking preserved
- Convergence: 5x loop with --converge, iteration 3 makes no changes → stops at 3, stoppedEarly=true
- Convergence disabled: 5x loop without --converge, iteration 3 makes no changes → continues to 5

**agent_end accumulation precedence:**
- Loop pushes to iterationSummaries, NOT anchorSummaries
- User anchor active + loop anchor at same ID → iterationSummaries only (no double-push)

**Integration (end-to-end):**
- Template loop with model+skill: model switched on iteration 1, skill injected every iteration, model restored after final iteration
- Chain+loop: chain runs completely for each iteration, collapses to autoAnchorId each time
- Cancel mid-loop: model restored, loopState cleared, no more iterations

## Constraints
- Do NOT modify handleChain() or executeChainStep() — they work for non-loop chains.
- The existing non-loop boomerang paths (template, chain, plain task) must continue working unchanged.
- Match existing code style exactly.

