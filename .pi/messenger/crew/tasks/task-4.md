# Implement executeLoopIteration, restartChainForLoop, and loop-aware before_agent_start

## Context

Implement the per-iteration dispatch function, the chain-restart function, and the loop-aware system prompt injection.

Read the full plan at ~/Documents/docs/boomerang-loop-plan.md (sections 3, 3b, 8) and the full codebase at index.ts before writing any code. Pay close attention to the existing `handleChain()`, `executeChainStep()`, and `before_agent_start` implementations.

## 1. `executeLoopIteration(ctx: ExtensionContext)`

This is the core dispatch function called for every loop iteration. It reads `loopState` to determine what to execute.

**Chain path** (`loopState.isChain`):
1. Call `restartChainForLoop(ctx)` (see below)

**Template path** (`loopState.templateRef` is set):
1. Load template: `loadTemplate(loopState.templateRef, loopState.commandCtx.cwd)`
2. If template not found: notify error, finalize loop early (restoreModelAndThinking, clearTaskState, loopState = null, updateStatus), return
3. Switch model if template specifies one: `resolveAndSwitchModel(template.models, ctx)`. On iteration 1 this performs the switch; on 2+ it returns `alreadyActive:true` (idempotent). If switch fails: finalize loop early, return.
4. Switch thinking level if template specifies one and it differs from current.
5. Load skill into `pendingSkill` if template has a `skill` field (re-set every iteration because `before_agent_start` consumes it).
6. Expand content: `substituteArgs(template.content, loopState.templateArgs || [])`
7. Build task display name from templateRef + args (same pattern as command handler).
8. Compute switchedToModel/switchedToThinking/injectedSkill for the summary Config line.
9. Set `pendingCollapse = { targetId: loopState.autoAnchorId, task: taskDisplayName, commandCtx: loopState.commandCtx, switchedToModel, switchedToThinking, injectedSkill }`
10. `updateStatus(ctx)`
11. `pi.sendUserMessage(expandedContent)`

**Plain task path** (else):
1. Set `pendingCollapse = { targetId: loopState.autoAnchorId, task: loopState.baseTask, commandCtx: loopState.commandCtx }`
2. `updateStatus(ctx)`
3. `pi.sendUserMessage(loopState.baseTask)`

## 2. `restartChainForLoop(ctx: ExtensionContext)`

This replaces `handleChain()` for chain+loop iterations. It MUST NOT call `handleChain()` directly because:
- `handleChain()` computes `targetId = anchorEntryId ?? startEntryId` — wrong when user anchor is set (should be `autoAnchorId`)
- `handleChain()` calls `clearTaskState()` then `previousModel = ctx.model` — would corrupt model save on iterations 2+

**Implementation:**
1. Parse `loopState.baseTask` through `parseChain()`. If null: notify error, finalize loop early, return.
2. Resolve all templates from the parsed steps (same validation loop as `handleChain`). If any template not found: error, finalize, return.
3. Create `chainState`:
   ```typescript
   chainState = {
     steps: resolvedSteps,
     globalArgs: parsed.globalArgs,
     currentIndex: 0,
     targetId: loopState.autoAnchorId,  // NOT anchorEntryId ?? leafId
     taskDisplayName: stepNames + ` (${steps.length} steps)`,
     commandCtx: loopState.commandCtx,
     configHistory: [],
   };
   ```
4. `updateStatus(ctx)`
5. Call `executeChainStep(ctx)` — this handles per-step model/thinking/skill switching, and sets `pendingCollapse` on the last step (using `chainState.targetId` which is now `autoAnchorId`).

**Key difference from handleChain:** No `clearTaskState()`, no `previousModel = ctx.model`, no `previousThinking = pi.getThinkingLevel()`, no `toolAnchorEntryId = null`. Just create chainState and start the chain.

## 3. Update `before_agent_start` hook

Currently when `boomerangActive`:
```typescript
systemPrompt += "\n\n" + BOOMERANG_INSTRUCTIONS;
if (pendingSkill) { /* inject skill */ }
```

**Add loop context** after BOOMERANG_INSTRUCTIONS, before skill injection:
```typescript
if (loopState) {
  systemPrompt += `\n\nLOOP ITERATION ${loopState.currentIteration}/${loopState.loopCount}\nYou are on iteration ${loopState.currentIteration} of ${loopState.loopCount} in a loop. Previous iterations made changes that are already applied to the codebase. Build on that work — do not repeat what was already done. Focus on what remains to improve.`;
}
```

## 4. Tests

**executeLoopIteration:**
- Template loop: sends expanded template content via `pi.sendUserMessage`
- Template loop: sets `pendingCollapse.targetId` to `loopState.autoAnchorId`
- Template loop: re-loads skill into `pendingSkill` each iteration
- Template loop: calls `resolveAndSwitchModel` for template's model spec
- Plain task loop: sends baseTask verbatim
- Template not found on iteration 2+: loop finalizes cleanly with model restore

**restartChainForLoop:**
- Creates `chainState` with `targetId = loopState.autoAnchorId` (NOT anchorEntryId)
- Does NOT overwrite `previousModel` or `previousThinking`
- Calls `executeChainStep` to start the chain
- Chain step model/thinking switching works (delegates to existing executeChainStep)

**before_agent_start:**
- Loop active: system prompt includes "LOOP ITERATION 3/5" text
- Loop active with skill: both loop context and skill are injected
- No loop: system prompt unchanged from existing behavior (regression)

## Constraints
- `executeLoopIteration` and `restartChainForLoop` are internal functions (not exported).
- Reuse existing helpers: `loadTemplate`, `resolveAndSwitchModel`, `resolveSkillPath`, `readSkillContent`, `substituteArgs`, `parseChain`, `executeChainStep`.
- Do NOT modify `handleChain()` or `executeChainStep()` — they work correctly for non-loop chains.
- Match existing code style.

