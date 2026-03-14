# Task for crew-worker

# Task Assignment

**Task ID:** task-2
**Task Title:** Add LoopState interface, state variable, and update cleanup/status functions
**PRD:** /Users/nicobailon/Documents/docs/boomerang-loop-plan.md


## Your Mission

Implement this task following the crew-worker protocol:
1. Join the mesh
2. Read task spec to understand requirements
3. Start task and reserve files
4. Implement the feature
5. Commit your changes
6. Release reservations and mark complete

## Concurrent Tasks

These tasks are being worked on by other workers in this wave. Discover their agent names after joining the mesh via `pi_messenger({ action: "list" })`.

- task-1: Implement extractLoopCount parser and didIterationMakeChanges
- task-3: Implement loop-aware summary accumulation in session_before_tree and generateSummaryFromEntries
- task-4: Implement executeLoopIteration, restartChainForLoop, and loop-aware before_agent_start
- task-5: Wire loop into command handler and agent_end hook
- task-6: Update CHANGELOG, README, and bump version

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
