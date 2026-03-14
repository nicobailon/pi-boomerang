# Update CHANGELOG, README, and bump version

## Context

Update documentation and version for the loop feature release.

Read the existing CHANGELOG.md and README.md in full before editing.

## 1. CHANGELOG.md

Add a new `[0.3.0]` section (this is a feature addition, minor version bump). Move current `[Unreleased]` content if any.

```markdown
## [0.3.0] - 2026-03-14

### Added

- **Loop execution** — Run tasks multiple times with `/boomerang /task 5x`. Each iteration collapses back to an auto-managed anchor point, with changes accumulating across iterations. Supports templates, chains, and plain tasks.
- **Convergence detection** — `--converge` flag stops the loop early if an iteration makes no file changes (e.g., `/boomerang /deslop 5x --converge`)
- **Loop-aware system prompt** — Agent is told which iteration it's on so it builds on previous work incrementally
- **Combined status indicators** — Shows `loop 2/5` during loops and `loop 2/5 · chain 1/3` for chain+loop combinations
```

## 2. README.md

Add a "Loop Execution" section after "Chain Execution" (before "Prompt Templates"):

```markdown
## Loop Execution

Run a task multiple times with changes accumulating across iterations:

\`\`\`bash
/boomerang /deslop 5x
/boomerang /scout -> /impl 3x -- "auth module"
/boomerang "improve code quality" 10x --converge
\`\`\`

Each iteration collapses back to the same anchor point. The agent sees all previous iteration summaries, so it builds on earlier work rather than starting from scratch.

Add `--converge` to stop early when an iteration makes no file changes — useful for iterative improvement tasks that naturally converge.

Status shows `loop 2/5` during execution. Cancel mid-loop with `/boomerang-cancel`.
```

Update the Commands table to include the loop syntax.

## 3. package.json

Bump version from `"0.2.1"` to `"0.3.0"`.

## Constraints
- Do NOT modify index.ts or index.test.ts.
- Keep the CHANGELOG concise and factual. No emoji.
- README section should be brief — the feature is simple to explain.

