/**
 * pi-boomerang - Token-efficient autonomous task execution
 *
 * Executes a task autonomously, then collapses the entire exchange into
 * a brief summary using navigateTree (like /tree does).
 *
 * Usage: /boomerang <task>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionEntry, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

interface BoomerangConfig {
  toolEnabled?: boolean;
  toolGuidance?: string | null;
}

function getConfigPath(): { dir: string; path: string } {
  const dir = join(homedir(), ".pi", "agent");
  return { dir, path: join(dir, "boomerang.json") };
}

function loadConfig(): BoomerangConfig {
  try {
    const { path } = getConfigPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // Ignore parse errors, return defaults
  }
  return {};
}

function saveConfig(config: BoomerangConfig): void {
  try {
    const { dir, path } = getConfigPath();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2));
  } catch {
    // Ignore write errors silently
  }
}

/**
 * Parse loop count and --converge flag from a raw task string.
 * 
 * Operates on raw strings with quote-aware boundary detection.
 * Splits around first standalone `--` (preserving chain global args).
 * Only scans the main segment (before `--`) for loop tokens.
 * 
 * Returns { task, loopCount, converge } or null if no Nx token found.
 */
export function extractLoopCount(task: string): {
  task: string;
  loopCount: number;
  converge: boolean;
} | null {
  if (!task) return null;

  // Find the first standalone -- separator (for chain global args)
  let mainSegmentEnd = task.length;
  let inQuote: string | null = null;
  let doubleDashPos = -1;

  for (let i = 0; i < task.length; i++) {
    const char = task[i];

    if (inQuote) {
      if (char === inQuote && (i === 0 || task[i - 1] !== "\\")) {
        inQuote = null;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === "-" && i + 1 < task.length && task[i + 1] === "-") {
      // Found --, check if it's standalone (surrounded by whitespace or start/end)
      const before = i === 0 || /\s/.test(task[i - 1]);
      const after = i + 2 >= task.length || /\s/.test(task[i + 2]);
      if (before && after) {
        doubleDashPos = i;
        mainSegmentEnd = i;
        break;
      }
    }
  }

  // Extract main segment and global args
  const mainSegment = task.slice(0, mainSegmentEnd).trim();
  if (!mainSegment) return null;

  // Parse main segment for loop tokens
  let loopCount: number | null = null;
  let converge = false;
  const tokensToRemove: Array<{ start: number; end: number }> = [];

  // Find standalone tokens in main segment (Nx and --converge)
  let i = 0;
  while (i < mainSegment.length) {
    // Skip quoted content
    if (mainSegment[i] === '"' || mainSegment[i] === "'") {
      const quote = mainSegment[i];
      i++;
      while (i < mainSegment.length && mainSegment[i] !== quote) {
        if (mainSegment[i] === "\\" && i + 1 < mainSegment.length) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < mainSegment.length) i++; // Skip closing quote
      continue;
    }

    // Skip whitespace
    if (/\s/.test(mainSegment[i])) {
      i++;
      continue;
    }

    // Found a non-whitespace, non-quote character - start of a token
    const tokenStart = i;
    while (i < mainSegment.length && !/\s/.test(mainSegment[i])) {
      i++;
    }
    const tokenEnd = i;
    const token = mainSegment.slice(tokenStart, tokenEnd);

    // Check for Nx pattern (1-999x)
    const loopMatch = token.match(/^\d{1,3}x$/);
    if (loopMatch) {
      const num = parseInt(token.slice(0, -1), 10);
      if (num >= 1 && num <= 999 && loopCount === null) {
        loopCount = num;
        tokensToRemove.push({ start: tokenStart, end: tokenEnd });
      }
    }

    // Check for --converge
    if (token === "--converge" && !converge) {
      converge = true;
      tokensToRemove.push({ start: tokenStart, end: tokenEnd });
    }
  }

  if (loopCount === null) return null;

  // Remove tokens by character position, preserving everything else
  // Sort removals by position (descending) to maintain indices
  tokensToRemove.sort((a, b) => b.start - a.start);

  let cleanedMain = mainSegment;
  for (const { start, end } of tokensToRemove) {
    cleanedMain = cleanedMain.slice(0, start) + cleanedMain.slice(end);
  }

  // Trim and reconstruct with global args if present
  const cleanedTask = cleanedMain.trim();
  let result = cleanedTask;
  if (doubleDashPos >= 0) {
    const globalArgs = task.slice(mainSegmentEnd).trim();
    result = `${cleanedTask} ${globalArgs}`.trim();
  }

  return {
    task: result,
    loopCount,
    converge,
  };
}

/**
 * Detect if an iteration made file changes.
 * 
 * Returns true if any write or edit tool calls are found.
 * Returns false if only read/bash calls or no tool calls.
 * Uses same entry filtering as generateSummaryFromEntries.
 */
export function didIterationMakeChanges(entries: SessionEntry[]): boolean {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "assistant") continue;

    for (const block of (msg as AssistantMessage).content) {
      if (block.type !== "toolCall") continue;
      if (block.name === "write" || block.name === "edit") {
        return true;
      }
    }
  }
  return false;
}

const BOOMERANG_INSTRUCTIONS = `BOOMERANG MODE ACTIVE

You are in boomerang mode - a token-efficient execution mode where:
1. You complete the task fully and autonomously (no clarifying questions)
2. When done, this entire exchange is collapsed into a brief summary
3. Future context will only show what was accomplished, not the step-by-step details

Make reasonable assumptions. Work thoroughly - there is no back-and-forth.
When finished, briefly state what you did.`;

// Signal to other extensions (like rewind) that boomerang collapse is in progress
// This allows them to skip interactive prompts and auto-select sensible defaults
declare global {
  var __boomerangCollapseInProgress: boolean | undefined;
}

interface PromptTemplate {
  content: string;
  models: string[];
  skill?: string;
  thinking?: ThinkingLevel;
}

interface ChainStep {
  templateRef: string;
  template: PromptTemplate;
  args: string[];
}

interface ChainState {
  steps: ChainStep[];
  globalArgs: string[];
  currentIndex: number;
  targetId: string;
  taskDisplayName: string;
  commandCtx: ExtensionCommandContext;
  configHistory: Array<{
    model?: string;
    thinking?: ThinkingLevel;
    skill?: string;
  }>;
}

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

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

export function parseChain(task: string): {
  steps: Array<{ templateRef: string; args: string[] }>;
  globalArgs: string[];
} | null {
  const tokens = parseCommandArgs(task);

  const globalSepIndex = tokens.indexOf("--");
  const mainTokens = globalSepIndex >= 0 ? tokens.slice(0, globalSepIndex) : tokens;
  const globalArgs = globalSepIndex >= 0 ? tokens.slice(globalSepIndex + 1) : [];

  if (!mainTokens.includes("->")) return null;

  const steps: Array<{ templateRef: string; args: string[] }> = [];
  let currentStepTokens: string[] = [];

  for (const token of mainTokens) {
    if (token === "->") {
      if (currentStepTokens.length === 0) return null;

      const ref = currentStepTokens[0];
      if (!ref.startsWith("/")) return null;

      steps.push({
        templateRef: ref.slice(1),
        args: currentStepTokens.slice(1),
      });
      currentStepTokens = [];
    } else {
      currentStepTokens.push(token);
    }
  }

  if (currentStepTokens.length === 0) return null;
  const lastRef = currentStepTokens[0];
  if (!lastRef.startsWith("/")) return null;
  steps.push({
    templateRef: lastRef.slice(1),
    args: currentStepTokens.slice(1),
  });

  if (steps.length < 2) return null;

  return { steps, globalArgs };
}

export function getEffectiveArgs(step: ChainStep, globalArgs: string[]): string[] {
  return step.args.length > 0 ? step.args : globalArgs;
}

export default function (pi: ExtensionAPI) {
  let boomerangActive = false;

  let anchorEntryId: string | null = null;
  let anchorSummaries: string[] = [];

  let pendingCollapse: {
    targetId: string;
    task: string;
    commandCtx: ExtensionCommandContext;
    switchedToModel?: string;
    switchedToThinking?: ThinkingLevel;
    injectedSkill?: string;
  } | null = null;

  let lastTaskSummary: string | null = null;

  let toolAnchorEntryId: string | null = null;
  let toolCollapsePending = false;
  let storedCommandCtx: ExtensionCommandContext | null = null;
  let justCollapsedEntryId: string | null = null;

  // Disabled by default — agents get aggressive with it otherwise
  const initialConfig = loadConfig();
  let toolEnabled = initialConfig.toolEnabled ?? false;
  let toolGuidance: string | null = initialConfig.toolGuidance ?? null;

  let pendingSkill: { name: string; content: string } | null = null;
  let previousModel: Model<any> | undefined = undefined;
  let previousThinking: ThinkingLevel | undefined = undefined;
  let chainState: ChainState | null = null;
  let loopState: LoopState | null = null;

  function parseFrontmatter(content: string): { frontmatter: Record<string, string>; content: string } {
    const frontmatter: Record<string, string> = {};
    const normalized = content.replace(/\r\n/g, "\n");

    if (!normalized.startsWith("---")) {
      return { frontmatter, content: normalized };
    }

    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) {
      return { frontmatter, content: normalized };
    }

    const frontmatterBlock = normalized.slice(4, endIndex);
    const body = normalized.slice(endIndex + 4).trim();

    for (const line of frontmatterBlock.split("\n")) {
      const match = line.match(/^([\w-]+):\s*(.*)$/);
      if (match) {
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        frontmatter[match[1]] = value;
      }
    }

    return { frontmatter, content: body };
  }

  function substituteArgs(content: string, args: string[]): string {
    let result = content;

    result = result.replace(/\$(\d+)/g, (_, num) => {
      const index = parseInt(num, 10) - 1;
      return args[index] ?? "";
    });

    const allArgs = args.join(" ");

    result = result.replace(/\$ARGUMENTS/g, allArgs);
    result = result.replace(/\$@/g, allArgs);

    return result;
  }

  function resolveSkillPath(skillName: string, cwd: string): string | undefined {
    const projectPath = resolve(cwd, ".pi", "skills", skillName, "SKILL.md");
    if (existsSync(projectPath)) return projectPath;

    const userPath = join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md");
    if (existsSync(userPath)) return userPath;

    return undefined;
  }

  function readSkillContent(skillPath: string): string | undefined {
    try {
      const raw = readFileSync(skillPath, "utf-8");
      const { content } = parseFrontmatter(raw);
      return content;
    } catch {
      return undefined;
    }
  }

  function parseTemplateFile(filePath: string): PromptTemplate | null {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const { frontmatter, content } = parseFrontmatter(raw);

      const models = frontmatter.model
        ? frontmatter.model.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      const thinkingRaw = frontmatter.thinking?.toLowerCase();
      const thinking = thinkingRaw && (VALID_THINKING_LEVELS as readonly string[]).includes(thinkingRaw)
        ? thinkingRaw as ThinkingLevel
        : undefined;

      return {
        content,
        models,
        skill: frontmatter.skill || undefined,
        thinking,
      };
    } catch {
      return null;
    }
  }

  function loadTemplate(templateRef: string, cwd: string): PromptTemplate | null {
    const normalizedRef = templateRef.replace(/\\/g, "/");
    if (!normalizedRef || normalizedRef.startsWith("/") || normalizedRef.split("/").includes("..")) {
      return null;
    }

    const projectPath = resolve(cwd, ".pi", "prompts", `${normalizedRef}.md`);
    if (existsSync(projectPath)) {
      return parseTemplateFile(projectPath);
    }

    const userPath = join(homedir(), ".pi", "agent", "prompts", `${normalizedRef}.md`);
    if (existsSync(userPath)) {
      return parseTemplateFile(userPath);
    }

    return null;
  }

  function resolveModel(modelSpec: string, ctx: ExtensionContext): Model<any> | undefined {
    const slashIndex = modelSpec.indexOf("/");

    if (slashIndex !== -1) {
      const provider = modelSpec.slice(0, slashIndex);
      const modelId = modelSpec.slice(slashIndex + 1);

      if (!provider || !modelId) return undefined;

      return ctx.modelRegistry.find(provider, modelId);
    }

    const allMatches = ctx.modelRegistry.getAll().filter((model) => model.id === modelSpec);

    if (allMatches.length === 0) return undefined;
    if (allMatches.length === 1) return allMatches[0];

    const availableMatches = ctx.modelRegistry.getAvailable().filter((model) => model.id === modelSpec);

    if (availableMatches.length === 1) return availableMatches[0];

    if (availableMatches.length > 1) {
      const preferredProviders = ["anthropic", "github-copilot", "openrouter"];
      for (const provider of preferredProviders) {
        const preferred = availableMatches.find((model) => model.provider === provider);
        if (preferred) return preferred;
      }
      return availableMatches[0];
    }

    return undefined;
  }

  async function resolveAndSwitchModel(
    modelSpecs: string[],
    ctx: ExtensionContext,
  ): Promise<{ model: Model<any>; alreadyActive: boolean } | undefined> {
    for (const spec of modelSpecs) {
      const model = resolveModel(spec, ctx);
      if (!model) continue;

      if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
        return { model, alreadyActive: true };
      }

      const success = await pi.setModel(model);
      if (success) {
        return { model, alreadyActive: false };
      }
    }

    ctx.ui.notify(`No available model from: ${modelSpecs.join(", ")}`, "error");
    return undefined;
  }

  async function restoreModelAndThinking(ctx: ExtensionContext): Promise<void> {
    const restoredParts: string[] = [];

    if (previousModel) {
      await pi.setModel(previousModel);
      restoredParts.push(previousModel.id);
      previousModel = undefined;
    }

    if (previousThinking !== undefined) {
      pi.setThinkingLevel(previousThinking);
      restoredParts.push(`thinking:${previousThinking}`);
      previousThinking = undefined;
    }

    if (restoredParts.length > 0) {
      ctx.ui.notify(`Restored to ${restoredParts.join(", ")}`, "info");
    }
  }

  function clearState() {
    boomerangActive = false;
    anchorEntryId = null;
    anchorSummaries = [];
    pendingCollapse = null;
    lastTaskSummary = null;
    toolAnchorEntryId = null;
    toolCollapsePending = false;
    storedCommandCtx = null;
    justCollapsedEntryId = null;
    pendingSkill = null;
    previousModel = undefined;
    previousThinking = undefined;
    chainState = null;
    loopState = null;
  }

  function clearTaskState() {
    boomerangActive = false;
    pendingCollapse = null;
    lastTaskSummary = null;
    pendingSkill = null;
    previousModel = undefined;
    previousThinking = undefined;
    chainState = null;
  }

  async function handleChain(
    parsed: { steps: Array<{ templateRef: string; args: string[] }>; globalArgs: string[] },
    ctx: ExtensionCommandContext
  ): Promise<void> {
    const startEntryId = ctx.sessionManager.getLeafId();
    const targetId = anchorEntryId ?? startEntryId;
    if (!targetId) {
      ctx.ui.notify("No session entry to start from", "error");
      return;
    }

    toolAnchorEntryId = null;
    toolCollapsePending = false;
    clearTaskState();

    const resolvedSteps: ChainStep[] = [];
    for (const step of parsed.steps) {
      const template = loadTemplate(step.templateRef, ctx.cwd);
      if (!template) {
        ctx.ui.notify(`Template "${step.templateRef}" not found`, "error");
        return;
      }
      resolvedSteps.push({
        templateRef: step.templateRef,
        template,
        args: step.args,
      });
    }

    previousModel = ctx.model;
    previousThinking = pi.getThinkingLevel();

    const stepNames = resolvedSteps.map((s) => `/${s.templateRef}`).join(" -> ");
    const taskDisplayName = `${stepNames} (${resolvedSteps.length} steps)`;

    chainState = {
      steps: resolvedSteps,
      globalArgs: parsed.globalArgs,
      currentIndex: 0,
      targetId,
      taskDisplayName,
      commandCtx: ctx,
      configHistory: [],
    };

    boomerangActive = true;
    updateStatus(ctx);

    ctx.ui.notify(`Chain started: ${stepNames}`, "info");

    await executeChainStep(ctx);
  }

  async function executeChainStep(ctx: ExtensionContext): Promise<void> {
    if (!chainState) return;

    const step = chainState.steps[chainState.currentIndex];
    const isLastStep = chainState.currentIndex === chainState.steps.length - 1;
    const stepNum = chainState.currentIndex + 1;
    const totalSteps = chainState.steps.length;

    ctx.ui.notify(`Step ${stepNum}/${totalSteps}: /${step.templateRef}`, "info");

    const configEntry: { model?: string; thinking?: ThinkingLevel; skill?: string } = {};

    if (step.template.models.length > 0) {
      const result = await resolveAndSwitchModel(step.template.models, ctx);
      if (!result) {
        ctx.ui.notify(`Chain aborted: couldn't switch model for step ${stepNum}`, "error");
        await restoreModelAndThinking(ctx);
        clearTaskState();
        updateStatus(ctx);
        return;
      }
      if (!result.alreadyActive) {
        configEntry.model = result.model.id;
      }
    }

    if (step.template.thinking) {
      const currentThinking = pi.getThinkingLevel();
      if (step.template.thinking !== currentThinking) {
        pi.setThinkingLevel(step.template.thinking);
        configEntry.thinking = step.template.thinking;
      }
    }

    if (step.template.skill) {
      const skillPath = resolveSkillPath(step.template.skill, chainState.commandCtx.cwd);
      if (skillPath) {
        const skillContent = readSkillContent(skillPath);
        if (skillContent) {
          pendingSkill = { name: step.template.skill, content: skillContent };
          configEntry.skill = step.template.skill;
        } else {
          ctx.ui.notify(`Failed to read skill "${step.template.skill}"`, "warning");
        }
      } else {
        ctx.ui.notify(`Skill "${step.template.skill}" not found`, "warning");
      }
    }

    chainState.configHistory.push(configEntry);

    if (isLastStep) {
      const allModels = chainState.configHistory
        .map((c) => c.model)
        .filter(Boolean) as string[];
      const allSkills = chainState.configHistory
        .map((c) => c.skill)
        .filter(Boolean) as string[];
      const lastThinking = chainState.configHistory
        .map((c) => c.thinking)
        .filter(Boolean)
        .pop();

      pendingCollapse = {
        targetId: chainState.targetId,
        task: chainState.taskDisplayName,
        commandCtx: chainState.commandCtx,
        switchedToModel: [...new Set(allModels)].join(", ") || undefined,
        switchedToThinking: lastThinking,
        injectedSkill: [...new Set(allSkills)].join(", ") || undefined,
      };
    }

    const effectiveArgs = getEffectiveArgs(step, chainState.globalArgs);
    const expandedContent = substituteArgs(step.template.content, effectiveArgs);

    pi.sendUserMessage(expandedContent);
  }

  async function restartChainForLoop(ctx: ExtensionContext): Promise<void> {
    if (!loopState) return;

    const parsed = parseChain(loopState.baseTask);
    if (!parsed) {
      ctx.ui.notify("Invalid chain syntax", "error");
      await restoreModelAndThinking(ctx);
      clearTaskState();
      loopState = null;
      updateStatus(ctx);
      return;
    }

    const resolvedSteps: ChainStep[] = [];
    for (const step of parsed.steps) {
      const template = loadTemplate(step.templateRef, loopState.commandCtx.cwd);
      if (!template) {
        ctx.ui.notify(`Template "${step.templateRef}" not found`, "error");
        await restoreModelAndThinking(ctx);
        clearTaskState();
        loopState = null;
        updateStatus(ctx);
        return;
      }
      resolvedSteps.push({
        templateRef: step.templateRef,
        template,
        args: step.args,
      });
    }

    const stepNames = resolvedSteps.map((s) => `/${s.templateRef}`).join(" -> ");
    const taskDisplayName = `${stepNames} (${resolvedSteps.length} steps)`;

    chainState = {
      steps: resolvedSteps,
      globalArgs: parsed.globalArgs,
      currentIndex: 0,
      targetId: loopState.autoAnchorId,
      taskDisplayName,
      commandCtx: loopState.commandCtx,
      configHistory: [],
    };

    updateStatus(ctx);
    ctx.ui.notify(`Chain iteration ${loopState.currentIteration}/${loopState.loopCount} started`, "info");

    await executeChainStep(ctx);
  }

  async function executeLoopIteration(ctx: ExtensionContext): Promise<void> {
    if (!loopState) return;

    if (loopState.isChain) {
      await restartChainForLoop(ctx);
      return;
    }

    if (loopState.templateRef) {
      const template = loadTemplate(loopState.templateRef, loopState.commandCtx.cwd);
      if (!template) {
        ctx.ui.notify(`Template "${loopState.templateRef}" not found`, "error");
        await restoreModelAndThinking(ctx);
        clearTaskState();
        loopState = null;
        updateStatus(ctx);
        return;
      }

      let switchedToModel: string | undefined;
      let switchedToThinking: ThinkingLevel | undefined;
      let injectedSkill: string | undefined;

      if (template.models.length > 0) {
        const result = await resolveAndSwitchModel(template.models, ctx);
        if (!result) {
          await restoreModelAndThinking(ctx);
          clearTaskState();
          loopState = null;
          updateStatus(ctx);
          return;
        }
        if (!result.alreadyActive) {
          switchedToModel = result.model.id;
        }
      }

      if (template.thinking) {
        const currentThinking = pi.getThinkingLevel();
        if (template.thinking !== currentThinking) {
          pi.setThinkingLevel(template.thinking);
          switchedToThinking = template.thinking;
        }
      }

      if (template.skill) {
        const skillPath = resolveSkillPath(template.skill, loopState.commandCtx.cwd);
        if (skillPath) {
          const skillContent = readSkillContent(skillPath);
          if (skillContent) {
            pendingSkill = { name: template.skill, content: skillContent };
            injectedSkill = template.skill;
          }
        }
      }

      const expandedContent = substituteArgs(template.content, loopState.templateArgs || []);
      const taskDisplayName = loopState.templateArgs && loopState.templateArgs.length > 0
        ? `/${loopState.templateRef} ${loopState.templateArgs.join(" ")}`.slice(0, 80)
        : `/${loopState.templateRef}`;

      pendingCollapse = {
        targetId: loopState.autoAnchorId,
        task: taskDisplayName,
        commandCtx: loopState.commandCtx,
        switchedToModel,
        switchedToThinking,
        injectedSkill,
      };

      updateStatus(ctx);
      pi.sendUserMessage(expandedContent);
      return;
    }

    // Plain task path
    pendingCollapse = {
      targetId: loopState.autoAnchorId,
      task: loopState.baseTask,
      commandCtx: loopState.commandCtx,
    };

    updateStatus(ctx);
    pi.sendUserMessage(loopState.baseTask);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (loopState && chainState) {
      const loopProgress = `loop ${loopState.currentIteration}/${loopState.loopCount}`;
      const chainProgress = `chain ${chainState.currentIndex + 1}/${chainState.steps.length}`;
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", `${loopProgress} · ${chainProgress}`));
    } else if (loopState) {
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", `loop ${loopState.currentIteration}/${loopState.loopCount}`));
    } else if (chainState) {
      const progress = `${chainState.currentIndex + 1}/${chainState.steps.length}`;
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", `chain ${progress}`));
    } else if (boomerangActive) {
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", "boomerang"));
    } else if (anchorEntryId !== null) {
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("accent", "anchor"));
    } else {
      ctx.ui.setStatus("boomerang", undefined);
    }
  }

  interface SummaryConfig {
    switchedToModel?: string;
    switchedToThinking?: ThinkingLevel;
    injectedSkill?: string;
  }

  function generateSummaryFromEntries(
    entries: SessionEntry[],
    task: string,
    config?: SummaryConfig,
    loopInfo?: { iteration: number; totalIterations: number }
  ): string {
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    let commandCount = 0;
    let lastAssistantText = "";

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "assistant") continue;

      for (const block of (msg as AssistantMessage).content) {
        if (block.type === "text") {
          lastAssistantText = block.text;
        }
        if (block.type !== "toolCall") continue;
        if (block.name === "bash") {
          commandCount++;
          continue;
        }
        const path = (block.arguments as Record<string, unknown>).path as string | undefined;
        if (block.name === "read" && path) filesRead.add(path);
        if (block.name === "write" && path) filesWritten.add(path);
        if (block.name === "edit" && path) filesWritten.add(path);
      }
    }

    const headerLabel = loopInfo
      ? `[BOOMERANG COMPLETE - LOOP ${loopInfo.iteration}/${loopInfo.totalIterations}]`
      : `[BOOMERANG COMPLETE]`;
    let summary = `${headerLabel}\nTask: "${task}"`;

    const configParts: string[] = [];
    if (config?.switchedToModel) configParts.push(`model: ${config.switchedToModel}`);
    if (config?.switchedToThinking) configParts.push(`thinking: ${config.switchedToThinking}`);
    if (config?.injectedSkill) configParts.push(`skill: ${config.injectedSkill}`);
    if (configParts.length > 0) {
      summary += `\nConfig: ${configParts.join(", ")}`;
    }

    const actionParts: string[] = [];
    if (filesRead.size > 0) actionParts.push(`read ${filesRead.size} file(s)`);
    if (filesWritten.size > 0) actionParts.push(`modified ${[...filesWritten].join(", ")}`);
    if (commandCount > 0) actionParts.push(`ran ${commandCount} command(s)`);
    if (actionParts.length > 0) {
      summary += `\nActions: ${actionParts.join(", ")}.`;
    }

    if (lastAssistantText) {
      const cleaned = lastAssistantText.replace(/\n+/g, " ").trim();
      const truncated = cleaned.slice(0, 500);
      const ellipsis = cleaned.length > 500 ? "..." : "";
      summary += `\nOutcome: ${truncated}${ellipsis}`;
    } else if (actionParts.length === 0 && configParts.length === 0) {
      summary += `\nResult: No output recorded.`;
    }

    return summary;
  }

  pi.registerCommand("boomerang", {
    description: "Execute task autonomously, then collapse context to summary",
    handler: async (args, ctx) => {
      storedCommandCtx = ctx;
      const trimmed = args.trim();

      if (trimmed === "anchor") {
        if (boomerangActive) {
          ctx.ui.notify("Cannot set anchor while boomerang is active", "error");
          return;
        }
        const leafId = ctx.sessionManager.getLeafId();
        if (!leafId) {
          ctx.ui.notify("No session entry to anchor", "error");
          return;
        }
        anchorEntryId = leafId;
        anchorSummaries = [];
        updateStatus(ctx);
        ctx.ui.notify("Anchor set. Subsequent boomerangs will collapse to this point.", "info");
        return;
      }

      if (trimmed === "anchor clear") {
        if (anchorEntryId === null) {
          ctx.ui.notify("No anchor set", "warning");
          return;
        }
        anchorEntryId = null;
        anchorSummaries = [];
        updateStatus(ctx);
        ctx.ui.notify("Anchor cleared", "info");
        return;
      }

      if (trimmed === "anchor show") {
        if (anchorEntryId === null) {
          ctx.ui.notify("No anchor set", "info");
        } else {
          ctx.ui.notify(
            `Anchor at entry ${anchorEntryId.slice(0, 8)}. ${anchorSummaries.length} task(s) completed.`,
            "info"
          );
        }
        return;
      }

      // Guidance subcommand (set guidance without changing enabled state)
      if (trimmed === "guidance" || trimmed.startsWith("guidance ")) {
        if (trimmed === "guidance" || trimmed === "guidance show") {
          if (toolGuidance) {
            ctx.ui.notify(`Current guidance: "${toolGuidance}"`, "info");
          } else {
            ctx.ui.notify("No guidance set. Use `/boomerang guidance <text>` to set.", "info");
          }
        } else if (trimmed === "guidance clear") {
          toolGuidance = null;
          saveConfig({ toolEnabled, toolGuidance });
          ctx.ui.notify("Guidance cleared.", "info");
        } else {
          const guidanceRaw = trimmed.slice("guidance".length).trim();
          toolGuidance = guidanceRaw.replace(/^["']|["']$/g, "");
          saveConfig({ toolEnabled, toolGuidance });
          ctx.ui.notify(`Guidance set: "${toolGuidance}"`, "info");
        }
        return;
      }

      if (trimmed === "tool" || trimmed.startsWith("tool ")) {
        if (trimmed === "tool off") {
          toolEnabled = false;
          saveConfig({ toolEnabled, toolGuidance });
          ctx.ui.notify("Boomerang tool disabled.", "info");
        } else if (trimmed === "tool on" || trimmed.startsWith("tool on ")) {
          toolEnabled = true;
          const guidanceRaw = trimmed.slice("tool on".length).trim();
          if (guidanceRaw) {
            toolGuidance = guidanceRaw.replace(/^["']|["']$/g, "");
            ctx.ui.notify(`Boomerang tool enabled with guidance: "${toolGuidance}"`, "info");
          } else {
            ctx.ui.notify("Boomerang tool enabled. Agent can now use boomerang().", "info");
          }
          saveConfig({ toolEnabled, toolGuidance });
        } else if (trimmed === "tool") {
          if (toolEnabled) {
            const guidanceInfo = toolGuidance ? ` | Guidance: "${toolGuidance}"` : "";
            ctx.ui.notify(`Boomerang tool is enabled${guidanceInfo}`, "info");
          } else {
            ctx.ui.notify("Boomerang tool is disabled", "info");
          }
        } else {
          ctx.ui.notify("Usage: /boomerang tool [on [guidance] | off]", "error");
        }
        return;
      }

      if (!trimmed) {
        ctx.ui.notify("Usage: /boomerang <task> | anchor | tool [on|off] | guidance [text|clear]", "error");
        return;
      }
      if (boomerangActive || chainState) {
        ctx.ui.notify("Boomerang already active. Use /boomerang-cancel to abort.", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait for completion first.", "error");
        return;
      }

      // Extract loop count and --converge flag
      const loopExtracted = extractLoopCount(trimmed);
      if (!loopExtracted) {
        // No loop specified, proceed normally
      } else {
        // Loop requested
        const startEntryId = ctx.sessionManager.getLeafId();
        if (!startEntryId && !anchorEntryId) {
          ctx.ui.notify("No session entry to start from", "error");
          return;
        }

        // Set auto-anchor at current leaf
        const autoAnchorId = anchorEntryId ?? startEntryId!;

        // Save model/thinking once for entire loop
        previousModel = ctx.model;
        previousThinking = pi.getThinkingLevel();

        // Clear task state but keep loop-relevant fields
        toolAnchorEntryId = null;
        toolCollapsePending = false;
        pendingCollapse = null;
        lastTaskSummary = null;
        chainState = null;

        // Determine task type
        const taskString = loopExtracted.task;
        const chainParsed = parseChain(taskString);
        const isTemplate = taskString.startsWith("/");

        if (chainParsed) {
          // Chain loop
          loopState = {
            loopCount: loopExtracted.loopCount,
            currentIteration: 1,
            stoppedEarly: false,
            autoAnchorId,
            iterationSummaries: [],
            convergenceEnabled: loopExtracted.converge,
            baseTask: taskString,
            isChain: true,
            commandCtx: ctx,
            lastIterationHadChanges: null,
          };
        } else if (isTemplate) {
          // Template loop
          const spaceIndex = taskString.indexOf(" ");
          const templateRef = spaceIndex > 0 ? taskString.slice(1, spaceIndex) : taskString.slice(1);
          const templateArgsStr = spaceIndex > 0 ? taskString.slice(spaceIndex + 1) : "";
          const templateArgs = parseCommandArgs(templateArgsStr);

          loopState = {
            loopCount: loopExtracted.loopCount,
            currentIteration: 1,
            stoppedEarly: false,
            autoAnchorId,
            iterationSummaries: [],
            convergenceEnabled: loopExtracted.converge,
            baseTask: taskString,
            isChain: false,
            templateRef,
            templateArgs,
            commandCtx: ctx,
            lastIterationHadChanges: null,
          };
        } else {
          // Plain task loop
          loopState = {
            loopCount: loopExtracted.loopCount,
            currentIteration: 1,
            stoppedEarly: false,
            autoAnchorId,
            iterationSummaries: [],
            convergenceEnabled: loopExtracted.converge,
            baseTask: taskString,
            isChain: false,
            commandCtx: ctx,
            lastIterationHadChanges: null,
          };
        }

        boomerangActive = true;
        updateStatus(ctx);
        ctx.ui.notify(`Loop started: ${loopExtracted.loopCount} iterations`, "info");

        await executeLoopIteration(ctx);
        return;
      }

      const chainParsed = parseChain(trimmed);
      if (chainParsed) {
        await handleChain(chainParsed, ctx);
        return;
      }

      const tokens = parseCommandArgs(trimmed);
      const looksLikeTemplateChain = tokens.some((token) => token.startsWith("/"));
      if (tokens.includes("->") && looksLikeTemplateChain) {
        ctx.ui.notify("Invalid chain syntax. Use: /template [args] -> /template [args] [-- global args]", "error");
        return;
      }

      const isTemplate = trimmed.startsWith("/");

      const startEntryId = ctx.sessionManager.getLeafId();
      if (!startEntryId && !anchorEntryId) {
        ctx.ui.notify("No session entry to start from", "error");
        return;
      }

      // Clear any orphaned tool state to prevent conflicts
      toolAnchorEntryId = null;
      toolCollapsePending = false;

      clearTaskState();

      let task = trimmed;
      let taskDisplayName = trimmed;

      if (isTemplate) {
        const spaceIndex = trimmed.indexOf(" ");
        const templateRef = spaceIndex > 0
          ? trimmed.slice(1, spaceIndex)
          : trimmed.slice(1);
        const templateArgs = spaceIndex > 0
          ? trimmed.slice(spaceIndex + 1)
          : "";

        const template = loadTemplate(templateRef, ctx.cwd);
        if (!template) {
          ctx.ui.notify(`Template "${templateRef}" not found`, "error");
          return;
        }

        const savedModel = ctx.model;
        const savedThinking = pi.getThinkingLevel();

        let switchedToModel: string | undefined;
        let switchedToThinking: ThinkingLevel | undefined;
        let injectedSkill: string | undefined;

        if (template.models.length > 0) {
          const result = await resolveAndSwitchModel(template.models, ctx);
          if (!result) return;

          if (!result.alreadyActive) {
            previousModel = savedModel;
            switchedToModel = result.model.id;
          }
        }

        if (template.thinking && template.thinking !== savedThinking) {
          previousThinking = savedThinking;
          pi.setThinkingLevel(template.thinking);
          switchedToThinking = template.thinking;
        }

        if (template.skill) {
          const skillPath = resolveSkillPath(template.skill, ctx.cwd);
          if (skillPath) {
            const skillContent = readSkillContent(skillPath);
            if (skillContent) {
              pendingSkill = { name: template.skill, content: skillContent };
              injectedSkill = template.skill;
            } else {
              ctx.ui.notify(`Failed to read skill "${template.skill}"`, "warning");
            }
          } else {
            ctx.ui.notify(`Skill "${template.skill}" not found`, "warning");
          }
        }

        const parsedArgs = parseCommandArgs(templateArgs);
        task = substituteArgs(template.content, parsedArgs);
        taskDisplayName = templateArgs
          ? `/${templateRef} ${templateArgs}`.slice(0, 80)
          : `/${templateRef}`;

        boomerangActive = true;

        const targetId = anchorEntryId ?? startEntryId!;
        pendingCollapse = { targetId, task: taskDisplayName, commandCtx: ctx, switchedToModel, switchedToThinking, injectedSkill };

        updateStatus(ctx);
        ctx.ui.notify("Boomerang started. Agent will work autonomously.", "info");

        pi.sendUserMessage(task);
        return;
      }

      boomerangActive = true;

      const targetId = anchorEntryId ?? startEntryId!;
      pendingCollapse = { targetId, task: taskDisplayName, commandCtx: ctx };

      updateStatus(ctx);
      ctx.ui.notify("Boomerang started. Agent will work autonomously.", "info");

      pi.sendUserMessage(task);
    },
  });

  pi.registerCommand("boomerang-cancel", {
    description: "Cancel active boomerang (no context collapse)",
    handler: async (_args, ctx) => {
      storedCommandCtx = ctx;
      const hasActive = boomerangActive || chainState || toolAnchorEntryId !== null || toolCollapsePending;
      if (!hasActive) {
        ctx.ui.notify("No boomerang active", "warning");
        return;
      }

      await restoreModelAndThinking(ctx);
      clearTaskState();
      loopState = null;
      toolAnchorEntryId = null;
      toolCollapsePending = false;
      updateStatus(ctx);
      ctx.ui.notify("Boomerang cancelled", "info");
    },
  });

  pi.registerTool({
    name: "boomerang",
    label: "Boomerang",
    description:
      "Toggle for token-efficient task execution. Call once to set an anchor point before starting a large task. Call again when done to collapse all work since the anchor into a brief summary. The collapsed context preserves what was accomplished without the step-by-step details.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      if (!toolEnabled) {
        return {
          content: [{ type: "text", text: "Boomerang tool is disabled. User must run `/boomerang tool on` to enable." }],
          details: {},
        };
      }

      // Don't allow tool during command boomerang - they would conflict
      if (boomerangActive) {
        return {
          content: [{ type: "text", text: "Command boomerang is active. Tool disabled until it completes." }],
          details: {},
        };
      }

      const sm = ctx.sessionManager as SessionManager;

      if (toolAnchorEntryId === null) {
        const leafId = sm.getLeafId();
        if (!leafId) {
          return {
            content: [{ type: "text", text: "Cannot set anchor: no session entries yet." }],
            details: {},
            isError: true,
          };
        }
        toolAnchorEntryId = leafId;
        return {
          content: [
            {
              type: "text",
              text: "Boomerang anchor set. Do your work, then call boomerang again to collapse the context.",
            },
          ],
          details: {},
        };
      }

      // Queue collapse for agent_end (which has access to navigateTree via storedCommandCtx)
      toolCollapsePending = true;
      return {
        content: [
          {
            type: "text",
            text: "Boomerang complete. Context will collapse when this turn ends.",
          },
        ],
        details: {},
      };
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let systemPrompt = event.systemPrompt;

    if (toolEnabled && !boomerangActive) {
      const guidance = toolGuidance
        ? `The boomerang tool is available for token-efficient task execution. ${toolGuidance}`
        : "The boomerang tool is available for token-efficient task execution. Use it for large, multi-step tasks where collapsing context afterward would be beneficial.";
      systemPrompt += `\n\n${guidance}`;
    }

    if (boomerangActive) {
      systemPrompt += "\n\n" + BOOMERANG_INSTRUCTIONS;

      if (loopState) {
        systemPrompt += `\n\nLOOP ITERATION ${loopState.currentIteration}/${loopState.loopCount}\nYou are on iteration ${loopState.currentIteration} of ${loopState.loopCount} in a loop. Previous iterations made changes that are already applied to the codebase. Build on that work — do not repeat what was already done. Focus on what remains to improve.`;
      }

      if (pendingSkill) {
        ctx.ui.notify(`Skill "${pendingSkill.name}" loaded`, "info");
        systemPrompt += `\n\n<skill name="${pendingSkill.name}">\n${pendingSkill.content}\n</skill>`;
        pendingSkill = null;
      }
    }

    if (systemPrompt !== event.systemPrompt) {
      return { systemPrompt };
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (chainState) {
      const nextIndex = chainState.currentIndex + 1;

      if (nextIndex < chainState.steps.length) {
        chainState.currentIndex = nextIndex;
        updateStatus(ctx);
        await executeChainStep(ctx);
        return;
      }

      chainState = null;
    }

    // Handle tool-initiated collapse
    if (toolCollapsePending && toolAnchorEntryId) {
      toolCollapsePending = false;

      if (!storedCommandCtx) {
        // Fallback: branchWithSummary then trigger new turn to pick up collapsed context
        const sm = ctx.sessionManager as SessionManager;
        const branch = sm.getBranch();
        const startIndex = branch.findIndex((entry) => entry.id === toolAnchorEntryId);
        const workEntries = startIndex >= 0 ? branch.slice(startIndex + 1) : [];
        const summary = generateSummaryFromEntries(workEntries, "Agent-initiated task");
        try {
          const entryId = sm.branchWithSummary(toolAnchorEntryId, summary);
          justCollapsedEntryId = entryId;
          ctx.ui.notify("Context collapsed (agent sees it; /reload to refresh display)", "info");
        } catch (err) {
          ctx.ui.notify(`Failed to collapse: ${err}`, "error");
        }
        toolAnchorEntryId = null;
        await restoreModelAndThinking(ctx);
        return;
      }

      // Use navigateTree for immediate UI update
      const targetId = toolAnchorEntryId;
      toolAnchorEntryId = null;
      pendingCollapse = { targetId, task: "Agent-initiated task", commandCtx: storedCommandCtx };

      try {
        globalThis.__boomerangCollapseInProgress = true;
        const result = await storedCommandCtx.navigateTree(targetId, { summarize: true });
        if (result.cancelled) {
          ctx.ui.notify("Collapse cancelled", "warning");
        } else {
          ctx.ui.notify("Boomerang complete. Context collapsed.", "info");
        }
      } catch (err) {
        ctx.ui.notify(`Failed to collapse: ${err}`, "error");
      } finally {
        globalThis.__boomerangCollapseInProgress = false;
      }
      pendingCollapse = null;
      await restoreModelAndThinking(ctx);
      return;
    }

    if (!boomerangActive || !pendingCollapse) return;

    const { targetId, task, commandCtx } = pendingCollapse;

    try {
      globalThis.__boomerangCollapseInProgress = true;
      const result = await commandCtx.navigateTree(targetId, { summarize: true });
      if (result.cancelled) {
        ctx.ui.notify("Collapse cancelled", "warning");
      } else {
        // Loop accumulation (precedence: loop > user-anchor)
        if (loopState && lastTaskSummary) {
          loopState.iterationSummaries.push(lastTaskSummary);
        } else if (anchorEntryId !== null && targetId === anchorEntryId && lastTaskSummary) {
          anchorSummaries.push(lastTaskSummary);
        }
        ctx.ui.notify("Boomerang complete. Context collapsed.", "info");
      }
    } catch (err) {
      ctx.ui.notify(`Failed to collapse: ${err}`, "error");
    } finally {
      globalThis.__boomerangCollapseInProgress = false;
    }

    // Handle loop iteration transitions (after collapse completes)
    if (loopState) {
      // Loop summary has already been recorded in the collapse block above

      // Check if we should continue
      const isLastIteration = loopState.currentIteration === loopState.loopCount;
      const hasConverged =
        loopState.convergenceEnabled && loopState.lastIterationHadChanges === false;

      if (isLastIteration || hasConverged) {
        // Finalize loop
        if (hasConverged) {
          loopState.stoppedEarly = true;
          ctx.ui.notify(
            `Loop converged at iteration ${loopState.currentIteration}/${loopState.loopCount}`,
            "info"
          );
        } else {
          ctx.ui.notify(
            `Loop completed: ${loopState.loopCount}/${loopState.loopCount} iterations`,
            "info"
          );
        }

        await restoreModelAndThinking(ctx);
        boomerangActive = false;
        loopState = null;
        pendingCollapse = null;
        lastTaskSummary = null;
        pendingSkill = null;
        updateStatus(ctx);
        return;
      }

      // Continue to next iteration
      loopState.currentIteration++;
      lastTaskSummary = null;
      pendingCollapse = null;
      pendingSkill = null;
      updateStatus(ctx);

      await executeLoopIteration(ctx);
      return;
    }

    await restoreModelAndThinking(ctx);
    clearTaskState();
    updateStatus(ctx);
  });

  pi.on("session_before_tree", async (event) => {
    if (!pendingCollapse) return;
    if (event.preparation.targetId !== pendingCollapse.targetId) return;

    const entries = event.preparation.entriesToSummarize;
    const config: SummaryConfig = {
      switchedToModel: pendingCollapse.switchedToModel,
      switchedToThinking: pendingCollapse.switchedToThinking,
      injectedSkill: pendingCollapse.injectedSkill,
    };

    // Generate summary, passing loop info if active
    const loopInfo = loopState
      ? {
          iteration: loopState.currentIteration,
          totalIterations: loopState.loopCount,
        }
      : undefined;
    const summary = generateSummaryFromEntries(entries, pendingCollapse.task, config, loopInfo);

    // Save for anchor accumulation (used in agent_end after successful collapse)
    lastTaskSummary = summary;

    // Set convergence signal: record whether this iteration made changes
    if (loopState) {
      loopState.lastIterationHadChanges = didIterationMakeChanges(entries);
    }

    // Loop/anchor precedence: check loop first, then user-anchor, then raw
    const isLoopCollapse = loopState !== null && pendingCollapse.targetId === loopState.autoAnchorId;
    const isAnchorCollapse =
      !isLoopCollapse && anchorEntryId !== null && pendingCollapse.targetId === anchorEntryId;

    let finalSummary: string;
    if (isLoopCollapse) {
      finalSummary = [...loopState.iterationSummaries, summary].join("\n\n---\n\n");
    } else if (isAnchorCollapse) {
      finalSummary = [...anchorSummaries, summary].join("\n\n---\n\n");
    } else {
      finalSummary = summary;
    }

    return {
      summary: {
        summary: finalSummary,
        details: { task: pendingCollapse.task },
      },
    };
  });

  pi.on("session_before_compact", async (event) => {
    if (justCollapsedEntryId !== null) {
      const lastEntry = event.branchEntries[event.branchEntries.length - 1];
      if (lastEntry?.id === justCollapsedEntryId) {
        justCollapsedEntryId = null;
        return { cancel: true };
      }
      justCollapsedEntryId = null;
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreModelAndThinking(ctx);
    clearState();
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await restoreModelAndThinking(ctx);
    clearState();
    updateStatus(ctx);
  });
}
