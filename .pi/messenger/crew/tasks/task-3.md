# Implement loop-aware summary accumulation in session_before_tree and generateSummaryFromEntries

## Context

Wire loop awareness into the summary generation and tree navigation hooks so each loop iteration gets its own labeled summary and summaries accumulate correctly.

Read the full plan at ~/Documents/docs/boomerang-loop-plan.md (sections 4, 5) and the full codebase at index.ts before writing any code.

## 1. Update `generateSummaryFromEntries()`

Add an optional `loopInfo` parameter:

```typescript
function generateSummaryFromEntries(
  entries: SessionEntry[],
  task: string,
  config?: SummaryConfig,
  loopInfo?: { iteration: number; totalIterations: number }
): string
```

When `loopInfo` is provided, change the header from `[BOOMERANG COMPLETE]` to `[BOOMERANG COMPLETE - LOOP {iteration}/{totalIterations}]`.

All other summary logic (filesRead, filesWritten, commandCount, lastAssistantText, Actions, Outcome, Config) stays identical.

## 2. Update `session_before_tree` hook

Currently it does:
1. Check `pendingCollapse` and `targetId` match
2. Generate summary via `generateSummaryFromEntries`
3. Save `lastTaskSummary = summary`
4. Check user-anchor accumulation: `isCollapsingToAnchor`
5. Return finalSummary

**Add loop handling:**

After generating the summary (step 2), if `loopState` is active, pass `loopInfo` to the generator:
```typescript
const loopInfo = loopState ? {
  iteration: loopState.currentIteration,
  totalIterations: loopState.loopCount
} : undefined;
const summary = generateSummaryFromEntries(entries, pendingCollapse.task, config, loopInfo);
```

**Add convergence signal** (step 2b):
```typescript
if (loopState) {
  loopState.lastIterationHadChanges = didIterationMakeChanges(entries);
}
```

This runs `didIterationMakeChanges` on the same `entries` used for summary generation. Both come from `event.preparation.entriesToSummarize`.

**Add loop accumulation with precedence** (replaces step 4-5):

Use if/else ordering — loop check FIRST, then user-anchor, then raw:
```typescript
const isLoopCollapse = loopState !== null && pendingCollapse.targetId === loopState.autoAnchorId;
const isAnchorCollapse = !isLoopCollapse && anchorEntryId !== null && pendingCollapse.targetId === anchorEntryId;

let finalSummary: string;
if (isLoopCollapse) {
  finalSummary = [...loopState.iterationSummaries, summary].join("\n\n---\n\n");
} else if (isAnchorCollapse) {
  finalSummary = [...anchorSummaries, summary].join("\n\n---\n\n");
} else {
  finalSummary = summary;
}
```

**Precedence matters:** When user anchor and auto-anchor are the same entry ID (user sets anchor, then immediately starts loop), loop must win. The `!isLoopCollapse` guard on the anchor check ensures this.

## 3. Tests

Add tests to index.test.ts:

**Summary generation:**
- `generateSummaryFromEntries` with loopInfo produces `[BOOMERANG COMPLETE - LOOP 2/5]` header
- `generateSummaryFromEntries` without loopInfo produces original `[BOOMERANG COMPLETE]` header (backward compat)

**session_before_tree accumulation:**
- Loop iteration 1: summary is just the current iteration's summary (iterationSummaries is empty)
- Loop iteration 3: finalSummary joins summaries from iterations 1, 2, 3 with `---` separator
- Loop collapse takes precedence over user-anchor collapse when both IDs match
- User-anchor collapse still works when no loop is active (regression check)

**Convergence signal:**
- `loopState.lastIterationHadChanges` is set to true when entries contain write/edit calls
- `loopState.lastIterationHadChanges` is set to false when entries contain only reads

## Constraints
- The `didIterationMakeChanges` function is imported from the exports added in task-1.
- The `loopState` variable and `LoopState` interface are from task-2.
- Do NOT modify the agent_end hook yet (that's task-5).
- Preserve all existing non-loop behavior. The new `loopInfo` parameter is optional.

