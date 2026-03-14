# Task for crew-reviewer

# Code Review Request

## Task Information

**Task ID:** task-2
**Task Title:** Add LoopState interface, state variable, and update cleanup/status functions
**PRD:** /Users/nicobailon/Documents/docs/boomerang-loop-plan.md

## Task Specification

# Add LoopState interface, state variable, and update cleanup/status functions

## Context

Add the LoopState type, the `loopState` variable, and wire it into all existing cleanup and status functions.

Read the full plan at ~/Documents/docs/boomerang-loop-plan.md (sections 2, 6, 7) and the full codebase at index.ts before writing any code.

## 1. LoopState Interface

Add after the existing `ChainState` interface:

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

## 2. State Variable

Add alongside the existing state variables (after `chainState`):
```typescript
let loopState: LoopState | null = null;
```

## 3. Update `clearState()`

Add `loopState = null;` to `clearState()`. This ensures session_start and session_switch clear loop state.

## 4. Update `boomerang-cancel` handler

Add `loopState = null;` to the cancel handler, AFTER `clearTaskState()`. The cancel handler already calls `restoreModelAndThinking()` → `clearTaskState()`. `clearTaskState()` does NOT clear loopState (and it shouldn't — loopState must survive between iterations). But cancel must clear it.

## 5. Update `updateStatus()`

Currently the function checks: `chainState` → `boomerangActive` → `anchorEntryId` → clear.

Add loop-aware checks **before** the existing ones:
```typescript
if (loopState && chainState) {
  const loopProgress = `loop ${loopState.currentIteration}/${loopState.loopCount}`;
  const chainProgress = `chain ${chainState.currentIndex + 1}/${chainState.steps.length}`;
  ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", `${loopProgress} · ${chainProgress}`));
} else if (loopState) {
  ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", `loop ${loopState.currentIteration}/${loopState.loopCount}`));
} else if (chainState) {
  // existing chain status
```

## 6. Tests

Add tests to index.test.ts:
- `loopState` clears on `session_start` event
- `loopState` clears on `session_switch` event
- `loopState` clears on `/boomerang-cancel`
- `updateStatus` shows "loop 2/5" when loopState is active
- `updateStatus` shows "loop 2/5 · chain 1/3" when both loopState and chainState are active
- `updateStatus` clears when loopState is null

## Constraints
- Do NOT modify `clearTaskState()`. Loop state must survive between iterations; only `clearState()` and the cancel handler should clear it.
- Match existing code style exactly.



## Changes

### Commits
*No commits*

### Diff
```diff
*No changes*
```

## Your Review

Review this implementation following the crew-reviewer protocol.
Output your verdict as SHIP, NEEDS_WORK, or MAJOR_RETHINK with detailed feedback.