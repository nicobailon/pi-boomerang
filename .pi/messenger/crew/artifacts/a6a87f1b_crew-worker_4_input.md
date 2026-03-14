# Task for crew-worker

# Task Assignment

**Task ID:** task-5
**Task Title:** Wire loop into command handler and agent_end hook
**PRD:** /Users/nicobailon/Documents/docs/boomerang-loop-plan.md


## Your Mission

Implement this task following the crew-worker protocol:
1. Join the mesh
2. Read task spec to understand requirements
3. Start task and reserve files
4. Implement the feature
5. Commit your changes
6. Release reservations and mark complete

## Dependency Status

Your task has dependencies on other tasks. Some may not be complete yet — this is expected. Use the coordination system to work through it.

- ○ task-3 (Implement loop-aware summary accumulation in session_before_tree and generateSummaryFromEntries) — not yet started
- ○ task-4 (Implement executeLoopIteration, restartChainForLoop, and loop-aware before_agent_start) — not yet started

**Working with pending dependencies:**
- Check if the dependency's output files exist. If yes, import and use them.
- If not, define what you need locally based on your task spec. Your spec describes the interfaces.
- DM in-progress workers for API details they're building.
- Reserve your files before editing to prevent conflicts.
- Do NOT block yourself because a dependency isn't done. Work around it.
- Log any local definitions in your progress for later reconciliation.

## Concurrent Tasks

These tasks are being worked on by other workers in this wave. Discover their agent names after joining the mesh via `pi_messenger({ action: "list" })`.

- task-1: Implement extractLoopCount parser and didIterationMakeChanges
- task-2: Add LoopState interface, state variable, and update cleanup/status functions
- task-3: Implement loop-aware summary accumulation in session_before_tree and generateSummaryFromEntries
- task-4: Implement executeLoopIteration, restartChainForLoop, and loop-aware before_agent_start
- task-6: Update CHANGELOG, README, and bump version

## Task Specification

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



## Plan Context

The task graph has **3 waves** of parallelism:

- **Wave 1**: Tasks 1 + 2 (parser/convergence functions and state/cleanup/status — independent)
- **Wave 2**: Tasks 3 + 4 (summary accumulation and iteration dispatch — both depend on wave 1, independent of each other)
- **Wave 3**: Task 5 (wiring it all together — depends on everything above)
- **Wave 4**: Task 6 (CHANGELOG — depends on Task 5)

Critical path is 4 steps deep: Task 1 or 2 → Task 3 or 4 → Task 5 → Task 6.
## Coordination

**Message budget: 10 messages this session.** The system enforces this — sends are rejected after the limit.

**Broadcasts go to the team feed — only the user sees them live.** Other workers see your broadcasts in their initial context only. Use DMs for time-sensitive peer coordination.

### Announce yourself
After joining the mesh and starting your task, announce what you're working on:

```typescript
pi_messenger({ action: "broadcast", message: "Starting <task-id> (<title>) — will create <files>" })
```

### Coordinate with peers
If a concurrent task involves files or interfaces related to yours, send a brief DM. Only message when there's a concrete coordination need — shared files, interfaces, or blocking questions.

```typescript
pi_messenger({ action: "send", to: "<peer-name>", message: "I'm exporting FormatOptions from types.ts — will you need it?" })
```

### Responding to messages
If a peer asks you a direct question, reply briefly. Ignore messages that don't require a response. Do NOT start casual conversations.

### On completion
Announce what you built:

```typescript
pi_messenger({ action: "broadcast", message: "Completed <task-id>: <file> exports <symbols>" })
```

### Reservations
Before editing files, check if another worker has reserved them via `pi_messenger({ action: "list" })`. If a file you need is reserved, message the owner to coordinate. Do NOT edit reserved files without coordinating first.

### Questions about dependencies
If your task depends on a completed task and something about its implementation is unclear, read the code and the task's progress log at `.pi/messenger/crew/tasks/<task-id>.progress.md`. Dependency authors are from previous waves and are no longer in the mesh.

### Claim next task
After completing your assigned task, check if there are ready tasks you can pick up:

```typescript
pi_messenger({ action: "task.ready" })
```

If a task is ready, claim and implement it. If `task.start` fails (another worker claimed it first), check for other ready tasks. Only claim if your current task completed cleanly and quickly.

## Available Skills

Read any skill that matches what you're implementing.

  agent-reflection — Manage the agent-reflection knowledge system on Mac mini. Includes Twitter/GitHub/YouTube sync, API server, CLI tools. Use when working with the knowledge base, fixing sync issues, or checking data pipelines. ALWAYS work from Mac mini remote, not MacBook.
    /Users/nicobailon/.pi/agent/skills/agent-reflection/SKILL.md
  building-tuis-with-charm — >-
    /Users/nicobailon/.pi/agent/skills/building-tuis-with-charm/SKILL.md
  chrome-devtools — Browser automation, debugging, and performance analysis using Puppeteer CLI scripts. Use for automating browsers, taking screenshots, analyzing performance, monitoring network traffic, web scraping, form automation, and JavaScript debugging.
    /Users/nicobailon/.pi/agent/skills/chrome-devtools/SKILL.md
  claude-cli — Claude Code CLI reference. Use when running claude in interactive_shell overlay or when user asks about claude CLI options.
    /Users/nicobailon/.pi/agent/skills/claude-cli/SKILL.md
  clean-copy — Reimplement a branch with a clean, narrative-quality commit history. Use when the user wants to clean up messy commits, create a reviewable PR, or rewrite history as a tutorial-style sequence. Creates a new branch, does not modify the source.
    /Users/nicobailon/.pi/agent/skills/clean-copy/SKILL.md
  cloudflare — Comprehensive Cloudflare platform skill covering Workers, Pages, storage (KV, D1, R2), AI (Workers AI, Vectorize, Agents SDK), networking (Tunnel, Spectrum), security (WAF, DDoS), and infrastructure-as-code (Terraform, Pulumi). Use for any Cloudflare development task.
    /Users/nicobailon/.pi/agent/skills/cloudflare/SKILL.md
  code-mode — Batch multiple tool operations into a single JavaScript execution. Use when a task requires multiple file reads, writes, edits, or bash commands that can be chained together to reduce round-trips and save tokens.
    /Users/nicobailon/.pi/agent/skills/code-mode/SKILL.md
  code-simplifier — Simplifies and refines code for clarity, consistency, and maintainability while preserving all functionality. Focuses on recently modified code unless instructed otherwise.
    /Users/nicobailon/.pi/agent/skills/code-simplifier/SKILL.md
  codex-5-3-prompting — How to write system prompts and instructions for GPT-5.3-Codex. Use when constructing or tuning prompts targeting Codex 5.3.
    /Users/nicobailon/.pi/agent/skills/codex-5-3-prompting/SKILL.md
  codex-cli — OpenAI Codex CLI reference. Use when running codex in interactive_shell overlay or when user asks about codex CLI options.
    /Users/nicobailon/.pi/agent/skills/codex-cli/SKILL.md
  coordination — Multi-agent coordination for parallel plan execution with the coordinate and coord_output tools.
    /Users/nicobailon/.pi/agent/skills/coordination/SKILL.md
  crafting-readme-files — >-
    /Users/nicobailon/.pi/agent/skills/crafting-readme-files/SKILL.md
  cursor-cli — Cursor Agent CLI reference. Use when running cursor agent in interactive_shell overlay or when user asks about cursor CLI options.
    /Users/nicobailon/.pi/agent/skills/cursor-cli/SKILL.md
  design-deck — Present visual options for architecture, UI, and code decisions with high-fidelity side-by-side previews. For comparing approaches visually — code diffs, diagrams, UI mockups, images — not for gathering structured input (use interview for that). Supports previewBlocks (code, mermaid, image, html), previewHtml, generate-more loops, and plan/PRD-driven flows.
    /Users/nicobailon/.pi/agent/skills/design-deck/SKILL.md
  extension-dev — Develop extensions for pi agent. Includes tips, gotchas, and patterns learned from building real extensions. Use when creating or modifying pi extensions, hooks, or TUI components.
    /Users/nicobailon/.pi/agent/skills/extension-dev/SKILL.md
  foreground-chains — Orchestrate multi-agent workflows where users watch each step in the overlay. Uses different CLI agents (cursor, pi, codex) for specialized roles with file-based handoff and auto-continue support for agents that pause mid-task.
    /Users/nicobailon/.pi/agent/skills/foreground-chains/SKILL.md
  frontend-design — Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.
    /Users/nicobailon/.pi/agent/skills/frontend-design/SKILL.md
  gemini-cli — Gemini CLI reference. Use when running gemini in interactive_shell overlay or when user asks about gemini CLI options.
    /Users/nicobailon/.pi/agent/skills/gemini-cli/SKILL.md
  gpt-5-4-prompting — How to write system prompts and instructions for GPT-5.4. Use when constructing or tuning prompts targeting GPT-5.4.
    /Users/nicobailon/.pi/agent/skills/gpt-5-4-prompting/SKILL.md
  llms-blog — Create and manage AI-friendly blogs with llms.txt support. Use when the user asks to create a blog, set up a blog, deploy a blog, or manage blog posts via the llms-blog CLI.
    /Users/nicobailon/.pi/agent/skills/llms-blog/SKILL.md
  macmini-remote — SSH into Mac mini via Tailscale for remote development. Run commands, manage tmux sessions, git worktrees. Use when user asks to work on the mini, run something remotely, or check the mini.
    /Users/nicobailon/.pi/agent/skills/macmini-remote/SKILL.md
  media-download — Download videos and media from social platforms (Instagram, YouTube, Twitter/X, TikTok, etc.) using yt-dlp. Use when user asks to download, save, or grab a video/media from a URL.
    /Users/nicobailon/.pi/agent/skills/media-download/SKILL.md
  media-processing — Process multimedia files with FFmpeg (video/audio encoding, conversion, streaming, filtering, hardware acceleration) and ImageMagick (image manipulation, format conversion, batch processing, effects, composition). Use when converting media formats, encoding videos with specific codecs (H.264, H.265, VP9), resizing/cropping images, extracting audio from video, applying filters and effects, optimizing file sizes, creating streaming manifests (HLS/DASH), generating thumbnails, batch processing images, creating composite images, implementing media processing pipelines, or creating animated WebP clips for README demos and documentation. Supports 100+ formats, hardware acceleration (NVENC, QSV), and complex filtergraphs.
    /Users/nicobailon/.pi/agent/skills/media-processing/SKILL.md
  parallel-scout — Investigate multiple questions in parallel using async scout subagents. Use when you need to research several independent questions against a codebase simultaneously, then synthesize the findings.
    /Users/nicobailon/.pi/agent/skills/parallel-scout/SKILL.md
  pi-cli — Pi coding agent CLI reference. Use when running pi in interactive_shell overlay, spawning pi subagents, or when user asks about pi CLI options.
    /Users/nicobailon/.pi/agent/skills/pi-cli/SKILL.md
  pi-messenger-crew — Use pi-messenger for multi-agent coordination and Crew task orchestration. Covers joining the mesh, planning from PRDs, working on tasks, file reservations, and agent messaging. Load this skill when using pi_messenger or building with Crew.
    /Users/nicobailon/.pi/agent/skills/pi-messenger-crew/SKILL.md
  plan-mode — Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a <proposed_plan> block.
    /Users/nicobailon/.pi/agent/skills/plan-mode/SKILL.md
  prompt-templates — Create and manage custom slash commands (prompt templates) for pi agent. Use when user asks to create a slash command, make a custom prompt, add a /command, write a prompt template, or wants reusable prompts. Also known as "slash commands" in Claude Code.
    /Users/nicobailon/.pi/agent/skills/prompt-templates/SKILL.md
  react-best-practices — React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimization, or performance improvements.
    /Users/nicobailon/.pi/agent/skills/react-best-practices/SKILL.md
  react-native-best-practices — Provides React Native performance optimization guidelines for FPS, TTI, bundle size, memory leaks, re-renders, and animations. Applies to tasks involving Hermes optimization, JS thread blocking, bridge overhead, FlashList, native modules, or debugging jank and frame drops.
    /Users/nicobailon/.pi/agent/skills/react-native-best-practices/SKILL.md
  remotion-best-practices — Best practices for Remotion - Video creation in React
    /Users/nicobailon/.pi/agent/skills/remotion-best-practices/SKILL.md
  safe-bash — Prevents bash commands from hanging by avoiding interactive commands, editors, pagers, REPLs, and prompts. Load this skill when running bash commands to ensure non-interactive execution patterns.
    /Users/nicobailon/.pi/agent/skills/safe-bash/SKILL.md
  shopify — Build Shopify applications, extensions, and themes using GraphQL/REST APIs, Shopify CLI, Polaris UI components, and Liquid templating. Capabilities include app development with OAuth authentication, checkout UI extensions for customizing checkout flow, admin UI extensions for dashboard integration, POS extensions for retail, theme development with Liquid, webhook management, billing API integration, product/order/customer management. Use when building Shopify apps, implementing checkout customizations, creating admin interfaces, developing themes, integrating payment processing, managing store data via APIs, or extending Shopify functionality.
    /Users/nicobailon/.pi/agent/skills/shopify/SKILL.md
  skill-creator — Guide for creating effective skills for pi coding agent. Use when users want to create a new skill or update an existing skill that extends pi's capabilities with specialized knowledge, workflows, or tool integrations.
    /Users/nicobailon/.pi/agent/skills/skill-creator/SKILL.md
  subagents — Delegate tasks to specialized subagents with chains, parallel execution, and async support. Use for task decomposition (scout → worker → reviewer), parallel information gathering, or isolated agent configurations.
    /Users/nicobailon/.pi/agent/skills/subagents/SKILL.md
  summarize — Summarize web pages and YouTube videos via LLM. Extracts clean text from URLs, fetches YouTube transcripts, and generates summaries. Use when user shares a URL to understand, asks to summarize a link, or needs content extracted from websites/videos.
    /Users/nicobailon/.pi/agent/skills/summarize/SKILL.md
  surf — Control Chrome browser via CLI for testing, automation, and debugging. Use when the user needs browser automation, screenshots, form filling, page inspection, network/CPU emulation, DevTools streaming, or AI queries via ChatGPT/Gemini/Perplexity/Grok/AI Studio.
    /Users/nicobailon/.pi/agent/skills/surf/SKILL.md
  threejs — Build 3D web apps with Three.js (WebGL/WebGPU). Use for 3D scenes, animations, custom shaders, PBR materials, VR/XR experiences, games, data visualizations, product configurators.
    /Users/nicobailon/.pi/agent/skills/threejs/SKILL.md
  tmux — Remote control tmux sessions for interactive CLIs (pi agents, python, gdb, psql, etc.) by sending keystrokes and scraping pane output.
    /Users/nicobailon/.pi/agent/skills/tmux/SKILL.md
  vercel-deploy — Deploy applications and websites to Vercel. Use this skill when the user requests deployment actions such as "Deploy my app", "Deploy this to production", "Create a preview deployment", "Deploy and give me the link", or "Push this live". No authentication required - returns preview URL and claimable deployment link.
    /Users/nicobailon/.pi/agent/skills/vercel-deploy/SKILL.md
  video-edit — Edit video files using ffmpeg. Speed up/slow down, convert formats, trim, resize, extract audio, add/remove audio tracks. Use when user asks to edit, convert, speed up, trim, or modify a video file.
    /Users/nicobailon/.pi/agent/skills/video-edit/SKILL.md
  visual-explainer — Generate beautiful, self-contained HTML pages that visually explain systems, code changes, plans, and data. Use when the user asks for a diagram, architecture overview, diff review, plan review, project recap, comparison table, or any visual explanation of technical concepts. Also use proactively when you are about to render a complex ASCII table (4+ rows or 3+ columns) — present it as a styled HTML page instead.
    /Users/nicobailon/.pi/agent/skills/visual-explainer/SKILL.md
  web-design-guidelines — Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
    /Users/nicobailon/.pi/agent/skills/web-design-guidelines/SKILL.md

To load a skill: read({ path: "<skill-path>" })
