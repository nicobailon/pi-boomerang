# Implement extractLoopCount parser and didIterationMakeChanges

## Context

Implement the two pure functions the loop feature needs. Both are exported for unit testing.

Read the full plan at ~/Documents/docs/boomerang-loop-plan.md (sections 1 and 4) and the full codebase at index.ts and index.test.ts before writing any code.

## 1. `extractLoopCount(task: string)`

**Signature:**
```typescript
export function extractLoopCount(task: string): {
  task: string;
  loopCount: number;
  converge: boolean;
} | null
```

**Behavior (from plan section 1):**
- Operates on the **raw string** with quote-aware boundary detection — NOT `parseCommandArgs()` followed by token-join (that strips quotes and breaks multi-word args).
- Splits around the first standalone `--` separator. Only the **main segment** (before `--`) is scanned for loop tokens. Global args after `--` are preserved untouched.
- Finds a standalone token matching `^\d{1,3}x$` (1-999) in the main segment. "Standalone" means surrounded by whitespace/start/end AND not inside quotes. Tokens like `fix5x` do NOT match.
- Finds `--converge` in the main segment (not in the global args after `--`).
- Strips matched tokens from the raw string **by character position** (tracking quote state), preserving all surrounding syntax verbatim. No re-quoting.
- Returns null if no `Nx` token found.
- **Ambiguity:** A standalone unquoted `Nx` is always consumed as a loop count. Users can quote `"3x"` to pass it as an arg.

**Post-extraction validation note:** The caller (command handler) will check for empty remaining task. This function just returns what it finds.

## 2. `didIterationMakeChanges(entries: SessionEntry[])`

**Signature:**
```typescript
export function didIterationMakeChanges(entries: SessionEntry[]): boolean
```

**Behavior (from plan section 4):**
- Iterates entries looking for assistant message tool calls.
- Returns `true` if any `write` or `edit` tool call is found.
- Returns `false` if only `read`, `bash`, or no tool calls.
- Uses the same entry filtering pattern as `generateSummaryFromEntries`: `entry.type !== "message"` → skip, `msg.role !== "assistant"` → skip.

## 3. Tests

Add tests to `index.test.ts` for both functions. Export them from `index.ts`.

**extractLoopCount tests:**
- `extractLoopCount("/task 5x")` → `{ task: "/task", loopCount: 5, converge: false }`
- `extractLoopCount('/a -> /b 2x -- "task"')` → `{ task: '/a -> /b -- "task"', loopCount: 2, converge: false }`
- `extractLoopCount("/task 5x --converge")` → `{ task: "/task", loopCount: 5, converge: true }`
- `extractLoopCount("/task --converge 5x")` → same (order-independent)
- Returns null for: no Nx token, "task 0x", "task 1000x", "task x5", single "/task"
- Does NOT parse from non-standalone: "/task fix5x" → null
- Does NOT parse `--converge` from after `--`: `"/task 5x -- --converge arg"` → converge: false
- Quoted `"3x"` is NOT consumed: `'/task "3x" 5x'` → `{ task: '/task "3x"', loopCount: 5, converge: false }`
- Handles both single and double quotes for boundary detection

**didIterationMakeChanges tests:**
- Entries with edit tool call → true
- Entries with write tool call → true
- Entries with only read tool calls → false
- Entries with only bash tool calls → false
- Empty entries → false
- Mixed: read + edit → true

## Constraints
- Do NOT modify any existing functions or behavior. Only add new exports.
- Match the existing code style exactly (formatting, naming, patterns).
- Keep both functions in index.ts (no new files).

