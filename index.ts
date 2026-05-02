/**
 * pi-boomerang - Token-efficient autonomous task execution
 *
 * Executes a task autonomously, then summarizes the exchange using
 * navigateTree (like /tree does).
 *
 * Usage: /boomerang <task>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionEntry, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";

interface BoomerangConfig {
  toolEnabled?: boolean;
  toolGuidance?: string | null;
}

function getConfigPath(): { dir: string; path: string } {
  const dir = join(homedir(), ".pi", "agent");
  return { dir, path: join(dir, "boomerang.json") };
}

function loadConfig(): BoomerangConfig {
  const { path } = getConfigPath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    const record = parsed as Record<string, unknown>;
    return {
      toolEnabled: typeof record.toolEnabled === "boolean" ? record.toolEnabled : undefined,
      toolGuidance:
        typeof record.toolGuidance === "string" || record.toolGuidance === null
          ? record.toolGuidance
          : undefined,
    };
  } catch (error) {
    console.error(`[boomerang] Failed to load config from ${path}: ${String(error)}`);
    // Extension initialization has no UI context; load with defaults after logging the exact config error.
    return {};
  }
}

function saveConfig(config: BoomerangConfig): string | null {
  try {
    const { dir, path } = getConfigPath();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2));
    return null;
  } catch (error) {
    return String(error);
  }
}

function saveConfigOrNotify(config: BoomerangConfig, ctx: ExtensionContext): void {
  const saveError = saveConfig(config);
  if (saveError) {
    ctx.ui.notify(`Failed to save boomerang config: ${saveError}`, "warning");
  }
}

function normalizeUnquotedWhitespace(value: string): string {
  let normalized = "";
  let inQuote: string | null = null;
  let previousWasSpace = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (inQuote) {
      normalized += char;
      if (char === inQuote && (i === 0 || value[i - 1] !== "\\")) {
        inQuote = null;
      }
      previousWasSpace = false;
      continue;
    }

    if (char === '"' || char === "'") {
      inQuote = char;
      normalized += char;
      previousWasSpace = false;
      continue;
    }

    if (/\s/.test(char)) {
      if (!previousWasSpace) {
        normalized += " ";
        previousWasSpace = true;
      }
      continue;
    }

    normalized += char;
    previousWasSpace = false;
  }

  return normalized.trim();
}

export function extractRethrow(task: string): {
  task: string;
  rethrowCount: number;
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

  // Parse main segment for --rethrow N
  let rethrowCount = 0;
  let hasRethrowToken = false;
  const tokensToRemove: Array<{ start: number; end: number }> = [];

  // Find standalone tokens in main segment (--rethrow and its count)
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

    if (token === "--rethrow" && !hasRethrowToken) {
      hasRethrowToken = true;
      tokensToRemove.push({ start: tokenStart, end: tokenEnd });

      let lookahead = i;
      while (lookahead < mainSegment.length && /\s/.test(mainSegment[lookahead])) {
        lookahead++;
      }

      if (lookahead < mainSegment.length && mainSegment[lookahead] !== '"' && mainSegment[lookahead] !== "'") {
        const countStart = lookahead;
        while (lookahead < mainSegment.length && !/\s/.test(mainSegment[lookahead])) {
          lookahead++;
        }
        const countToken = mainSegment.slice(countStart, lookahead);
        if (/^\d+$/.test(countToken)) {
          const parsed = parseInt(countToken, 10);
          if (parsed >= 1 && parsed <= 999) {
            rethrowCount = parsed;
            tokensToRemove.push({ start: countStart, end: lookahead });
            i = lookahead;
          }
        }
      }
    }
  }

  if (!hasRethrowToken) return null;

  // Remove tokens by character position, preserving everything else
  // Sort removals by position (descending) to maintain indices
  tokensToRemove.sort((a, b) => b.start - a.start);

  let cleanedMain = mainSegment;
  for (const { start, end } of tokensToRemove) {
    cleanedMain = cleanedMain.slice(0, start) + cleanedMain.slice(end);
  }

  const cleanedTask = normalizeUnquotedWhitespace(cleanedMain);
  if (!cleanedTask) {
    return {
      task: "",
      rethrowCount,
    };
  }
  let result = cleanedTask;
  if (doubleDashPos >= 0) {
    const globalArgs = task.slice(mainSegmentEnd).trim();
    result = `${cleanedTask} ${globalArgs}`.trim();
  }

  return {
    task: result,
    rethrowCount,
  };
}

function extractLoopAlias(task: string): {
  task: string;
  rethrowCount: number;
} | null {
  if (!task) return null;

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
      const before = i === 0 || /\s/.test(task[i - 1]);
      const after = i + 2 >= task.length || /\s/.test(task[i + 2]);
      if (before && after) {
        doubleDashPos = i;
        mainSegmentEnd = i;
        break;
      }
    }
  }

  const mainSegment = task.slice(0, mainSegmentEnd).trim();
  if (!mainSegment) return null;

  let rethrowCount = 0;
  let hasLoopToken = false;
  const tokensToRemove: Array<{ start: number; end: number }> = [];

  let i = 0;
  while (i < mainSegment.length) {
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
      if (i < mainSegment.length) i++;
      continue;
    }

    if (/\s/.test(mainSegment[i])) {
      i++;
      continue;
    }

    const tokenStart = i;
    while (i < mainSegment.length && !/\s/.test(mainSegment[i])) {
      i++;
    }
    const tokenEnd = i;
    const token = mainSegment.slice(tokenStart, tokenEnd);

    if (token === "--loop") {
      hasLoopToken = true;
      tokensToRemove.push({ start: tokenStart, end: tokenEnd });

      let lookahead = i;
      while (lookahead < mainSegment.length && /\s/.test(mainSegment[lookahead])) {
        lookahead++;
      }

      if (lookahead < mainSegment.length && mainSegment[lookahead] !== '"' && mainSegment[lookahead] !== "'") {
        const countStart = lookahead;
        while (lookahead < mainSegment.length && !/\s/.test(mainSegment[lookahead])) {
          lookahead++;
        }
        const countToken = mainSegment.slice(countStart, lookahead);
        if (/^\d+$/.test(countToken)) {
          const parsed = parseInt(countToken, 10);
          tokensToRemove.push({ start: countStart, end: lookahead });
          if (parsed >= 1 && parsed <= 999 && rethrowCount < 1) {
            rethrowCount = parsed;
          }
          i = lookahead;
        }
      }
      continue;
    }

    if (token.startsWith("--loop=")) {
      hasLoopToken = true;
      tokensToRemove.push({ start: tokenStart, end: tokenEnd });

      const value = token.slice("--loop=".length);
      if (/^\d+$/.test(value)) {
        const parsed = parseInt(value, 10);
        if (parsed >= 1 && parsed <= 999 && rethrowCount < 1) {
          rethrowCount = parsed;
        }
      }
    }
  }

  if (!hasLoopToken) return null;

  tokensToRemove.sort((a, b) => b.start - a.start);

  let cleanedMain = mainSegment;
  for (const { start, end } of tokensToRemove) {
    cleanedMain = cleanedMain.slice(0, start) + cleanedMain.slice(end);
  }

  const cleanedTask = normalizeUnquotedWhitespace(cleanedMain);
  if (!cleanedTask) {
    return {
      task: "",
      rethrowCount,
    };
  }

  let result = cleanedTask;
  if (doubleDashPos >= 0) {
    const globalArgs = task.slice(mainSegmentEnd).trim();
    result = `${cleanedTask} ${globalArgs}`.trim();
  }

  return {
    task: result,
    rethrowCount,
  };
}

const BOOMERANG_INSTRUCTIONS = `BOOMERANG MODE ACTIVE

You are in boomerang mode - a token-efficient execution mode where:
1. You complete the task fully and autonomously (no clarifying questions)
2. When done, this entire exchange is summarized into a brief handoff
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

interface RethrowState {
  rethrowCount: number;
  currentRethrow: number;
  autoAnchorId: string;
  rethrowSummaries: string[];
  baseTask: string;
  isChain: boolean;
  templateRef?: string;
  templateArgs?: string[];
  commandCtx: ExtensionCommandContext;
}

const TEMPLATE_LOAD_FAILED = Symbol("template-load-failed");
type TemplateLoadResult = PromptTemplate | null | typeof TEMPLATE_LOAD_FAILED;

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

// Extension commands are dispatched before input handlers; this list mirrors Pi's built-in control commands so auto mode does not wrap them as prompt templates.
const PI_CONTROL_COMMANDS = new Set([
  "settings",
  "model",
  "scoped-models",
  "export",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "tree",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
]);

function isPiControlCommandInput(text: string): boolean {
  const firstToken = parseCommandArgs(text.trim())[0];
  if (!firstToken?.startsWith("/")) return false;
  return PI_CONTROL_COMMANDS.has(firstToken.slice(1));
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

  const initialConfig = loadConfig();
  let toolEnabled = initialConfig.toolEnabled ?? false;
  let toolGuidance: string | null = initialConfig.toolGuidance ?? null;
  let toolRegistered = false;

  let pendingSkill: { name: string; content: string } | null = null;
  let previousModel: Model<any> | undefined = undefined;
  let previousThinking: ThinkingLevel | undefined = undefined;
  let chainState: ChainState | null = null;
  let rethrowState: RethrowState | null = null;
  let toolQueuedTask: string | null = null;
  let awaitingAssistantForTask: { afterEntryId: string | null; userTask: string } | null = null;
  let autoBoomerangEnabled = false;
  let autoBoomerangCandidate: { targetId: string | null; task: string } | null = null;
  let autoFallbackCollapse: { targetId: string | null; task: string } | null = null;
  let autoAwaitingAssistantAfterId: string | null = null;

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
    result = result.replace(/@\$/g, allArgs);

    return result;
  }

  function resolveSkillPath(skillName: string, cwd: string): string | undefined {
    const projectPath = resolve(cwd, ".pi", "skills", skillName, "SKILL.md");
    if (existsSync(projectPath)) return projectPath;

    const userPath = join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md");
    if (existsSync(userPath)) return userPath;

    return undefined;
  }

  function readSkillContent(skillPath: string): string {
    const raw = readFileSync(skillPath, "utf-8");
    const { content } = parseFrontmatter(raw);
    return content;
  }

  function injectSkill(skillName: string, cwd: string, ctx: ExtensionContext): string | undefined {
    const skillPath = resolveSkillPath(skillName, cwd);
    if (!skillPath) {
      ctx.ui.notify(`Skill "${skillName}" not found`, "warning");
      return undefined;
    }
    try {
      const content = readSkillContent(skillPath);
      pendingSkill = { name: skillName, content };
      return skillName;
    } catch (err) {
      ctx.ui.notify(`Failed to read skill "${skillName}": ${String(err)}`, "warning");
      return undefined;
    }
  }

  function parseTemplateFile(filePath: string): PromptTemplate {
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

  function loadTemplateOrNotify(templateRef: string, cwd: string, ctx: ExtensionContext): TemplateLoadResult {
    try {
      return loadTemplate(templateRef, cwd);
    } catch (err) {
      ctx.ui.notify(`Failed to read template "${templateRef}": ${String(err)}`, "error");
      return TEMPLATE_LOAD_FAILED;
    }
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
    const restoreErrors: string[] = [];

    if (previousModel) {
      const modelToRestore = previousModel;
      previousModel = undefined;

      try {
        const restored = await pi.setModel(modelToRestore);
        if (restored) {
          restoredParts.push(modelToRestore.id);
        } else {
          restoreErrors.push(`model:${modelToRestore.provider}/${modelToRestore.id}`);
        }
      } catch (error) {
        restoreErrors.push(`model:${modelToRestore.provider}/${modelToRestore.id} (${String(error)})`);
      }
    }

    if (previousThinking !== undefined) {
      const thinkingToRestore = previousThinking;
      previousThinking = undefined;

      const alreadyOnThinking = pi.getThinkingLevel() === thinkingToRestore;
      if (!alreadyOnThinking) {
        try {
          pi.setThinkingLevel(thinkingToRestore);
          restoredParts.push(`thinking:${thinkingToRestore}`);
        } catch (error) {
          restoreErrors.push(`thinking:${thinkingToRestore} (${String(error)})`);
        }
      }
    }

    if (restoredParts.length > 0) {
      ctx.ui.notify(`Restored to ${restoredParts.join(", ")}`, "info");
    }
    if (restoreErrors.length > 0) {
      ctx.ui.notify(`Failed to restore ${restoreErrors.join(", ")}`, "warning");
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
    toolQueuedTask = null;
    storedCommandCtx = null;
    justCollapsedEntryId = null;
    pendingSkill = null;
    previousModel = undefined;
    previousThinking = undefined;
    chainState = null;
    rethrowState = null;
    awaitingAssistantForTask = null;
    autoBoomerangEnabled = false;
    autoBoomerangCandidate = null;
    autoFallbackCollapse = null;
    autoAwaitingAssistantAfterId = null;
  }

  function clearTaskState() {
    boomerangActive = false;
    pendingCollapse = null;
    lastTaskSummary = null;
    pendingSkill = null;
    previousModel = undefined;
    previousThinking = undefined;
    chainState = null;
    awaitingAssistantForTask = null;
    autoBoomerangCandidate = null;
    autoFallbackCollapse = null;
    autoAwaitingAssistantAfterId = null;
  }

  function markAwaitingAssistant(
    ctx: ExtensionContext,
    userTask: string,
    fallbackEntryId: string | null = null
  ): void {
    const markerId = fallbackEntryId ?? ctx.sessionManager.getLeafId();
    awaitingAssistantForTask = { afterEntryId: markerId, userTask };
  }

  function getUserMessageText(entry: SessionEntry): string | null {
    if (entry.type !== "message" || entry.message.role !== "user") {
      return null;
    }

    if (typeof entry.message.content === "string") {
      return entry.message.content;
    }

    if (Array.isArray(entry.message.content)) {
      const textParts = entry.message.content
        .filter((block): block is { type: "text"; text: string } =>
          typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string"
        )
        .map((block) => block.text);

      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }

    return null;
  }

  function hasAssistantMessageAfterTask(
    entries: SessionEntry[],
    awaited: { afterEntryId: string | null; userTask: string }
  ): boolean {
    const startIndex = awaited.afterEntryId
      ? entries.findIndex((entry) => entry.id === awaited.afterEntryId)
      : -1;
    if (awaited.afterEntryId && startIndex === -1) {
      return false;
    }

    let taskMessageIndex = -1;
    for (let i = startIndex + 1; i < entries.length; i++) {
      const userText = getUserMessageText(entries[i]);
      if (userText === awaited.userTask) {
        taskMessageIndex = i;
        break;
      }
    }
    if (taskMessageIndex === -1) {
      return false;
    }

    return hasAssistantMessageAfterIndex(entries, taskMessageIndex);
  }

  function hasAssistantMessageAfterEntry(entries: SessionEntry[], entryId: string | null): boolean {
    const startIndex = entryId === null
      ? -1
      : entries.findIndex((entry) => entry.id === entryId);
    if (entryId !== null && startIndex === -1) {
      return false;
    }
    return hasAssistantMessageAfterIndex(entries, startIndex);
  }

  function hasAssistantMessageAfterIndex(entries: SessionEntry[], startIndex: number): boolean {
    for (let i = startIndex + 1; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === "message" && entry.message.role === "assistant") {
        return true;
      }
    }

    return false;
  }

  async function handleChain(
    parsed: { steps: Array<{ templateRef: string; args: string[] }>; globalArgs: string[] },
    ctx: ExtensionCommandContext,
    restoreSnapshot?: { model?: Model<any>; thinking?: ThinkingLevel }
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
      const template = loadTemplateOrNotify(step.templateRef, ctx.cwd, ctx);
      if (template === TEMPLATE_LOAD_FAILED) {
        return;
      }
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

    previousModel = restoreSnapshot?.model ?? ctx.model;
    previousThinking = restoreSnapshot?.thinking ?? pi.getThinkingLevel();

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
    keepBoomerangExpanded(ctx);
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
      configEntry.skill = injectSkill(step.template.skill, chainState.commandCtx.cwd, ctx);
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
    const leafBeforeSend = ctx.sessionManager.getLeafId();

    pi.sendUserMessage(expandedContent);
    markAwaitingAssistant(ctx, expandedContent, leafBeforeSend ?? chainState.targetId);
  }

  async function waitForTurnStart(
    ctx: ExtensionContext,
    shouldContinue: () => boolean = () => true
  ): Promise<boolean> {
    while (ctx.isIdle()) {
      if (!shouldContinue()) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }

  async function runRethrowLoop(ctx: ExtensionCommandContext): Promise<void> {
    if (!rethrowState) return;

    const totalRethrows = rethrowState.rethrowCount;
    let completedRethrows = 0;

    try {
      for (let i = 1; i <= totalRethrows; i++) {
        if (!boomerangActive || !rethrowState) break;
        const currentRethrow = rethrowState;
        const commandCtx = currentRethrow.commandCtx;
        const rethrowCwd = commandCtx.cwd;

        currentRethrow.currentRethrow = i;
        updateStatus(ctx);

        let aborted = false;
        let switchedToModel: string | undefined;
        let switchedToThinking: ThinkingLevel | undefined;
        let injectedSkill: string | undefined;
        let taskDisplayName = currentRethrow.baseTask;
        lastTaskSummary = null;

        if (currentRethrow.isChain) {
          const parsed = parseChain(currentRethrow.baseTask);
          if (!parsed) {
            ctx.ui.notify("Invalid chain syntax", "error");
            aborted = true;
          } else {
            const configHistory: Array<{ model?: string; thinking?: ThinkingLevel; skill?: string }> = [];
            const stepNames = parsed.steps.map((s) => `/${s.templateRef}`).join(" -> ");
            taskDisplayName = `${stepNames} (${parsed.steps.length} steps)`;

            for (let stepIndex = 0; stepIndex < parsed.steps.length; stepIndex++) {
              if (!boomerangActive || !rethrowState) break;

              const step = parsed.steps[stepIndex];
              const template = loadTemplateOrNotify(step.templateRef, rethrowCwd, ctx);
              if (template === TEMPLATE_LOAD_FAILED) {
                aborted = true;
                break;
              }
              if (!template) {
                ctx.ui.notify(`Template "${step.templateRef}" not found`, "error");
                aborted = true;
                break;
              }

              const configEntry: { model?: string; thinking?: ThinkingLevel; skill?: string } = {};
              if (template.models.length > 0) {
                const result = await resolveAndSwitchModel(template.models, ctx);
                if (!boomerangActive || !rethrowState) break;
                if (!result) {
                  ctx.ui.notify(`Chain aborted: couldn't switch model for step ${stepIndex + 1}`, "error");
                  aborted = true;
                  break;
                }
                if (!result.alreadyActive) {
                  configEntry.model = result.model.id;
                }
              }

              if (template.thinking) {
                const currentThinking = pi.getThinkingLevel();
                if (template.thinking !== currentThinking) {
                  pi.setThinkingLevel(template.thinking);
                  configEntry.thinking = template.thinking;
                }
              }

              if (template.skill) {
                configEntry.skill = injectSkill(template.skill, rethrowCwd, ctx);
              }
              configHistory.push(configEntry);

              ctx.ui.setStatus(
                "boomerang",
                ctx.ui.theme.fg("warning", `rethrow ${i}/${totalRethrows} · chain ${stepIndex + 1}/${parsed.steps.length}`)
              );

              const effectiveArgs = step.args.length > 0 ? step.args : parsed.globalArgs;
              const expandedContent = substituteArgs(template.content, effectiveArgs);
              pi.sendUserMessage(expandedContent);
              const turnStarted = await waitForTurnStart(ctx, () => boomerangActive && rethrowState !== null);
              if (!turnStarted) break;
              await ctx.waitForIdle();

              if (!boomerangActive || !rethrowState) break;
            }

            const allModels = configHistory.map((c) => c.model).filter(Boolean) as string[];
            const allSkills = configHistory.map((c) => c.skill).filter(Boolean) as string[];
            const lastThinking = configHistory.map((c) => c.thinking).filter(Boolean).pop();

            switchedToModel = [...new Set(allModels)].join(", ") || undefined;
            switchedToThinking = lastThinking;
            injectedSkill = [...new Set(allSkills)].join(", ") || undefined;
          }
        } else if (currentRethrow.templateRef) {
          const template = loadTemplateOrNotify(currentRethrow.templateRef, rethrowCwd, ctx);
          if (template === TEMPLATE_LOAD_FAILED) {
            aborted = true;
          } else if (!template) {
            ctx.ui.notify(`Template "${currentRethrow.templateRef}" not found`, "error");
            aborted = true;
          } else {
            const templateArgs = currentRethrow.templateArgs || [];
            const templateTask = currentRethrow.baseTask;

            if (template.models.length > 0) {
              const result = await resolveAndSwitchModel(template.models, ctx);
              if (!boomerangActive || !rethrowState) {
                aborted = true;
              } else if (!result) {
                aborted = true;
              } else if (!result.alreadyActive) {
                switchedToModel = result.model.id;
              }
            }

            if (!aborted && template.thinking) {
              const currentThinking = pi.getThinkingLevel();
              if (template.thinking !== currentThinking) {
                pi.setThinkingLevel(template.thinking);
                switchedToThinking = template.thinking;
              }
            }

            if (!aborted && template.skill) {
              injectedSkill = injectSkill(template.skill, rethrowCwd, ctx);
            }

            if (!aborted) {
              const expandedContent = substituteArgs(template.content, templateArgs);
              taskDisplayName = templateTask.slice(0, 80);
              pi.sendUserMessage(expandedContent);
              const turnStarted = await waitForTurnStart(ctx, () => boomerangActive && rethrowState !== null);
              if (turnStarted) {
                await ctx.waitForIdle();
              }
            }
          }
        } else {
          pi.sendUserMessage(currentRethrow.baseTask);
          const turnStarted = await waitForTurnStart(ctx, () => boomerangActive && rethrowState !== null);
          if (turnStarted) {
            await ctx.waitForIdle();
          }
        }

        if (aborted || !boomerangActive || !rethrowState) break;

        pendingCollapse = {
          targetId: currentRethrow.autoAnchorId,
          task: taskDisplayName,
          commandCtx,
          switchedToModel,
          switchedToThinking,
          injectedSkill,
        };

        let collapseResult: { cancelled: boolean } | undefined;
        try {
          globalThis.__boomerangCollapseInProgress = true;
          keepBoomerangExpanded(ctx);
          collapseResult = await commandCtx.navigateTree(currentRethrow.autoAnchorId, { summarize: true });
        } catch (err) {
          ctx.ui.notify(`Failed to summarize: ${String(err)}`, "error");
          break;
        } finally {
          globalThis.__boomerangCollapseInProgress = false;
        }
        pendingCollapse = null;

        if (!collapseResult || collapseResult.cancelled) {
          ctx.ui.notify("Summary cancelled", "warning");
          break;
        }
        if (!boomerangActive || !rethrowState) break;

        if (lastTaskSummary) {
          rethrowState.rethrowSummaries.push(lastTaskSummary);
        }
        lastTaskSummary = null;

        ctx.ui.notify(`Rethrow ${i}/${totalRethrows} summarized`, "info");
        completedRethrows = i;
        updateStatus(ctx);
      }
    } finally {
      const completedNormally = rethrowState !== null && boomerangActive && completedRethrows === totalRethrows;
      await restoreModelAndThinking(ctx);
      rethrowState = null;
      clearTaskState();
      updateStatus(ctx);
      if (completedNormally) {
        ctx.ui.notify(`Rethrow complete: ${totalRethrows}/${totalRethrows}`, "info");
        triggerOrchestratorHandoff();
      }
    }
  }

  function keepBoomerangExpanded(ctx: Pick<ExtensionContext, "hasUI" | "ui">) {
    if (ctx.hasUI) {
      ctx.ui.setToolsExpanded(true);
    }
  }

  function triggerOrchestratorHandoff() {
    pi.sendMessage({
      customType: "boomerang-handoff",
      content: "A boomerang task completed. Read the latest [BOOMERANG COMPLETE] summary and continue from it.",
      display: false,
    }, {
      triggerTurn: true,
      deliverAs: "followUp",
    });
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (rethrowState) {
      ctx.ui.setStatus(
        "boomerang",
        ctx.ui.theme.fg("warning", `rethrow ${rethrowState.currentRethrow}/${rethrowState.rethrowCount}`)
      );
    } else if (chainState) {
      const progress = `${chainState.currentIndex + 1}/${chainState.steps.length}`;
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", `chain ${progress}`));
    } else if (boomerangActive) {
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", "boomerang"));
    } else if (autoBoomerangEnabled) {
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("accent", "🪃 auto"));
    } else if (anchorEntryId !== null) {
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("accent", "anchor"));
    } else {
      ctx.ui.setStatus("boomerang", undefined);
    }
  }

  function setAutoBoomerang(enabled: boolean, ctx: ExtensionContext): void {
    autoBoomerangEnabled = enabled;
    updateStatus(ctx);
    ctx.ui.notify(`Auto-boomerang ${enabled ? "enabled" : "disabled"}.`, "info");
  }

  interface SummaryConfig {
    switchedToModel?: string;
    switchedToThinking?: ThinkingLevel;
    injectedSkill?: string;
  }

  interface BoomerangSummaryDetails {
    task: string;
    readFiles: string[];
    modifiedFiles: string[];
    validationCommands: string[];
    failedOperations: string[];
    commandCount: number;
  }

  interface BoomerangSummary {
    summary: string;
    details: BoomerangSummaryDetails;
  }

  const READ_FILE_LIMIT = 12;

  function isValidationCommand(command: string): boolean {
    return /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|verify)\b/.test(command)
      || /(^|\s)(vitest|jest|pytest|ruff|cargo\s+test|go\s+test|swift\s+test)\b/.test(command)
      || /(^|\s)git\s+diff\s+--check\b/.test(command);
  }

  function formatCommand(command: string): string {
    const singleLine = command.replace(/\s+/g, " ").trim();
    return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
  }

  function formatList(items: string[]): string {
    return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
  }

  function collectBoomerangSummaryDetails(entries: SessionEntry[], task: string): BoomerangSummaryDetails & { outcome: string } {
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    const validationCommands = new Set<string>();
    const failedOperations: string[] = [];
    const bashCommandsById = new Map<string, string>();
    let commandCount = 0;
    let lastAssistantText = "";

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;

      if (msg.role === "assistant") {
        for (const block of (msg as AssistantMessage).content) {
          if (block.type === "text") {
            lastAssistantText = block.text;
          }
          if (block.type !== "toolCall") continue;

          if (block.name === "bash") {
            commandCount++;
            const command = (block.arguments as Record<string, unknown>).command;
            if (typeof command === "string") {
              const formattedCommand = formatCommand(command);
              bashCommandsById.set(block.id, formattedCommand);
              if (isValidationCommand(command)) {
                validationCommands.add(formattedCommand);
              }
            }
            continue;
          }

          const path = (block.arguments as Record<string, unknown>).path;
          if (typeof path !== "string" || !path) continue;
          const cleanPath = path.replace(/^@/, "");
          if (block.name === "read") filesRead.add(cleanPath);
          if (block.name === "write" || block.name === "edit") filesWritten.add(cleanPath);
        }
        continue;
      }

      if (msg.role === "toolResult" && msg.isError) {
        const text = Array.isArray(msg.content)
          ? msg.content
              .filter((block) => block.type === "text")
              .map((block) => block.text.trim())
              .filter(Boolean)
              .join(" ")
          : "";
        const errorText = text.length > 160 ? `${text.slice(0, 157)}...` : text;
        const failedCommand = bashCommandsById.get(msg.toolCallId);
        const operation = failedCommand ? `${msg.toolName} \`${failedCommand}\`` : msg.toolName;
        failedOperations.push(errorText ? `${operation}: ${errorText}` : operation);
      }
    }

    const modifiedFiles = [...filesWritten].sort();
    const readFiles = [...filesRead].filter((path) => !filesWritten.has(path)).sort();

    return {
      task,
      readFiles,
      modifiedFiles,
      validationCommands: [...validationCommands].sort(),
      failedOperations,
      commandCount,
      outcome: lastAssistantText.replace(/\r\n?/g, "\n").trim(),
    };
  }

  function generateSummaryFromEntries(
    entries: SessionEntry[],
    task: string,
    config?: SummaryConfig,
    rethrowInfo?: { rethrow: number; totalRethrows: number }
  ): BoomerangSummary {
    const details = collectBoomerangSummaryDetails(entries, task);
    const headerLabel = rethrowInfo
      ? `[BOOMERANG COMPLETE - RETHROW ${rethrowInfo.rethrow}/${rethrowInfo.totalRethrows}]`
      : `[BOOMERANG COMPLETE]`;

    const sections = [
      headerLabel,
      `Task: "${task}"`,
      `Outcome:\n${details.outcome || "No assistant outcome recorded."}`,
      `Changed Files:\n${formatList(details.modifiedFiles)}`,
    ];

    const visibleReadFiles = details.readFiles.slice(0, READ_FILE_LIMIT);
    if (visibleReadFiles.length > 0) {
      const omittedCount = details.readFiles.length - visibleReadFiles.length;
      sections.push(
        `Relevant Reads:\n${formatList(visibleReadFiles)}${omittedCount > 0 ? `\n- ... ${omittedCount} more read-only file(s)` : ""}`
      );
    }

    const commandLines = [`- Ran ${details.commandCount} command(s)`];
    if (details.validationCommands.length > 0) {
      commandLines.push(`- Validation: ${details.validationCommands.map((command) => `\`${command}\``).join(", ")}`);
    }
    commandLines.push(
      details.failedOperations.length > 0
        ? `- Failures: ${details.failedOperations.join("; ")}`
        : "- Failures: none detected"
    );
    sections.push(`Commands:\n${commandLines.join("\n")}`);

    const configParts: string[] = [];
    if (config?.switchedToModel) configParts.push(`- model: ${config.switchedToModel}`);
    if (config?.switchedToThinking) configParts.push(`- thinking: ${config.switchedToThinking}`);
    if (config?.injectedSkill) configParts.push(`- skill: ${config.injectedSkill}`);
    if (configParts.length > 0) {
      sections.push(`Config:\n${configParts.join("\n")}`);
    }

    return {
      summary: sections.join("\n\n"),
      details: {
        task: details.task,
        readFiles: details.readFiles,
        modifiedFiles: details.modifiedFiles,
        validationCommands: details.validationCommands,
        failedOperations: details.failedOperations,
        commandCount: details.commandCount,
      },
    };
  }

  async function startTask(
    trimmed: string,
    ctx: ExtensionCommandContext,
    restoreSnapshot?: { model?: Model<any>; thinking?: ThinkingLevel }
  ): Promise<void> {
    const modelSnapshot = restoreSnapshot?.model ?? ctx.model;
    const thinkingSnapshot = restoreSnapshot?.thinking ?? pi.getThinkingLevel();
    const rethrowExtracted = extractRethrow(trimmed);
    let extracted = rethrowExtracted;
    let usedLoopAlias = false;
    let ignoredLoopAlias = false;

    if (rethrowExtracted) {
      const strippedLoopAlias = extractLoopAlias(rethrowExtracted.task);
      if (strippedLoopAlias) {
        extracted = {
          task: strippedLoopAlias.task,
          rethrowCount: rethrowExtracted.rethrowCount,
        };
        ignoredLoopAlias = true;
      }
    } else {
      const extractedLoopAlias = extractLoopAlias(trimmed);
      if (extractedLoopAlias) {
        extracted = extractedLoopAlias;
        usedLoopAlias = true;
      }
    }

    if (extracted) {
      if (extracted.rethrowCount < 1) {
        const invalidFlag = rethrowExtracted ? "--rethrow" : "--loop";
        ctx.ui.notify(`${invalidFlag} requires a count (1-999)`, "error");
        return;
      }

      if (!extracted.task.trim()) {
        const usageFlag = rethrowExtracted ? "--rethrow N" : "--loop N";
        ctx.ui.notify(`Usage: /boomerang <task> [${usageFlag}]`, "error");
        return;
      }

      const startEntryId = ctx.sessionManager.getLeafId();
      if (!startEntryId) {
        ctx.ui.notify("No session entry to start from", "error");
        return;
      }

      const autoAnchorId = startEntryId;
      const taskString = extracted.task;
      const chainParsed = parseChain(taskString);
      const isTemplate = taskString.startsWith("/");
      const taskTokens = parseCommandArgs(taskString);
      const looksLikeTemplateChain = taskTokens.some((token) => token.startsWith("/"));

      if (!chainParsed && taskTokens.includes("->") && looksLikeTemplateChain) {
        ctx.ui.notify("Invalid chain syntax. Use: /template [args] -> /template [args] [-- global args]", "error");
        return;
      }

      previousModel = modelSnapshot;
      previousThinking = thinkingSnapshot;

      toolAnchorEntryId = null;
      toolCollapsePending = false;
      pendingCollapse = null;
      lastTaskSummary = null;
      pendingSkill = null;
      chainState = null;

      rethrowState = {
        rethrowCount: extracted.rethrowCount,
        currentRethrow: 1,
        autoAnchorId,
        rethrowSummaries: [],
        baseTask: taskString,
        isChain: !!chainParsed,
        commandCtx: ctx,
      };

      if (!chainParsed && isTemplate) {
        const spaceIndex = taskString.indexOf(" ");
        rethrowState.templateRef = spaceIndex > 0 ? taskString.slice(1, spaceIndex) : taskString.slice(1);
        const templateArgsStr = spaceIndex > 0 ? taskString.slice(spaceIndex + 1) : "";
        rethrowState.templateArgs = parseCommandArgs(templateArgsStr);
      }

      boomerangActive = true;
      keepBoomerangExpanded(ctx);
      updateStatus(ctx);
      if (usedLoopAlias) {
        ctx.ui.notify(`Mapped --loop to boomerang --rethrow ${extracted.rethrowCount}.`, "info");
      }
      if (ignoredLoopAlias) {
        ctx.ui.notify(`Ignored --loop because --rethrow is set. Using --rethrow ${extracted.rethrowCount}.`, "info");
      }
      ctx.ui.notify(`Rethrow started: ${extracted.rethrowCount} iterations`, "info");

      await runRethrowLoop(ctx);
      return;
    }

    const chainParsed = parseChain(trimmed);
    if (chainParsed) {
      await handleChain(chainParsed, ctx, { model: modelSnapshot, thinking: thinkingSnapshot });
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

      const template = loadTemplateOrNotify(templateRef, ctx.cwd, ctx);
      if (template === TEMPLATE_LOAD_FAILED) {
        return;
      }
      if (!template) {
        ctx.ui.notify(`Template "${templateRef}" not found`, "error");
        return;
      }

      const savedModel = modelSnapshot;
      const savedThinking = thinkingSnapshot;

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
        injectedSkill = injectSkill(template.skill, ctx.cwd, ctx);
      }

      const parsedArgs = parseCommandArgs(templateArgs);
      task = substituteArgs(template.content, parsedArgs);
      taskDisplayName = templateArgs
        ? `/${templateRef} ${templateArgs}`.slice(0, 80)
        : `/${templateRef}`;

      boomerangActive = true;
      keepBoomerangExpanded(ctx);

      const targetId = anchorEntryId ?? startEntryId!;
      pendingCollapse = { targetId, task: taskDisplayName, commandCtx: ctx, switchedToModel, switchedToThinking, injectedSkill };

      updateStatus(ctx);
      ctx.ui.notify("Boomerang started. Agent will work autonomously.", "info");

      const leafBeforeSend = ctx.sessionManager.getLeafId();
      pi.sendUserMessage(task);
      markAwaitingAssistant(ctx, task, leafBeforeSend ?? targetId);
      return;
    }

    boomerangActive = true;
    keepBoomerangExpanded(ctx);

    const targetId = anchorEntryId ?? startEntryId!;
    pendingCollapse = { targetId, task: taskDisplayName, commandCtx: ctx };

    updateStatus(ctx);
    ctx.ui.notify("Boomerang started. Agent will work autonomously.", "info");

    const leafBeforeSend = ctx.sessionManager.getLeafId();
    pi.sendUserMessage(task);
    markAwaitingAssistant(ctx, task, leafBeforeSend ?? targetId);
  }

  pi.registerCommand("boomerang", {
    description: "Execute task autonomously, then summarize context",
    handler: async (args, ctx) => {
      storedCommandCtx = ctx;
      const trimmed = args.trim();

      if (trimmed === "auto" || trimmed.startsWith("auto ")) {
        const mode = trimmed === "auto" ? "toggle" : trimmed.slice("auto".length).trim();
        if (mode === "on") {
          setAutoBoomerang(true, ctx);
        } else if (mode === "off") {
          setAutoBoomerang(false, ctx);
        } else if (mode === "toggle") {
          setAutoBoomerang(!autoBoomerangEnabled, ctx);
        } else if (mode === "status") {
          ctx.ui.notify(`Auto-boomerang is ${autoBoomerangEnabled ? "enabled" : "disabled"}.`, "info");
        } else {
          ctx.ui.notify("Usage: /boomerang auto [on|off|toggle|status]", "error");
        }
        return;
      }

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
        ctx.ui.notify("Anchor set. Subsequent boomerangs will summarize to this point.", "info");
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
          saveConfigOrNotify({ toolEnabled, toolGuidance }, ctx);
          ctx.ui.notify("Guidance cleared.", "info");
        } else {
          const guidanceRaw = trimmed.slice("guidance".length).trim();
          toolGuidance = guidanceRaw.replace(/^["']|["']$/g, "");
          saveConfigOrNotify({ toolEnabled, toolGuidance }, ctx);
          ctx.ui.notify(`Guidance set: "${toolGuidance}"`, "info");
        }
        return;
      }

      if (trimmed === "tool" || trimmed.startsWith("tool ")) {
        if (trimmed === "tool off") {
          toolEnabled = false;
          saveConfigOrNotify({ toolEnabled, toolGuidance }, ctx);
          ctx.ui.notify("Boomerang tool disabled.", "info");
        } else if (trimmed === "tool on" || trimmed.startsWith("tool on ")) {
          toolEnabled = true;
          ensureToolRegistered();
          const guidanceRaw = trimmed.slice("tool on".length).trim();
          if (guidanceRaw) {
            toolGuidance = guidanceRaw.replace(/^["']|["']$/g, "");
            ctx.ui.notify(`Boomerang tool enabled with guidance: "${toolGuidance}"`, "info");
          } else {
            ctx.ui.notify("Boomerang tool enabled. Agent can now use boomerang().", "info");
          }
          saveConfigOrNotify({ toolEnabled, toolGuidance }, ctx);
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
        ctx.ui.notify("Usage: /boomerang <task> | auto [on|off|toggle|status] | anchor | tool [on|off] | guidance [text|clear]", "error");
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

      await startTask(trimmed, ctx, { model: ctx.model, thinking: pi.getThinkingLevel() });
    },
  });

  pi.registerCommand("boomerang-cancel", {
    description: "Cancel active boomerang (no context summary)",
    handler: async (_args, ctx) => {
      storedCommandCtx = ctx;
      const hasActive = boomerangActive || chainState || toolAnchorEntryId !== null || toolCollapsePending || toolQueuedTask !== null;
      if (!hasActive) {
        ctx.ui.notify("No boomerang active", "warning");
        return;
      }

      await restoreModelAndThinking(ctx);
      clearTaskState();
      rethrowState = null;
      toolAnchorEntryId = null;
      toolCollapsePending = false;
      toolQueuedTask = null;
      updateStatus(ctx);
      ctx.ui.notify("Boomerang cancelled", "info");
    },
  });

  pi.registerShortcut("ctrl+alt+b", {
    description: "Toggle auto-boomerang mode",
    handler: async (ctx) => {
      setAutoBoomerang(!autoBoomerangEnabled, ctx);
    },
  });

  pi.on("input", async (event, ctx) => {
    autoBoomerangCandidate = null;
    if (!autoBoomerangEnabled) return;
    if (boomerangActive || pendingCollapse || rethrowState || chainState || toolCollapsePending || toolQueuedTask || toolAnchorEntryId) return;
    if (!event.text.trim() || isPiControlCommandInput(event.text)) return;

    autoBoomerangCandidate = {
      targetId: ctx.sessionManager.getLeafId(),
      task: event.text.trim(),
    };
  });

  function ensureToolRegistered() {
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: "boomerang",
      label: "Boomerang",
      description:
        "Execute a task autonomously in boomerang mode, then summarize context. " +
        "Pass a task string to run it. Use --rethrow N to rerun the full task with summaries between rethrows. " +
        "If no task is provided, toggles an anchor/summary point for manual use.",
      promptSnippet:
        "Use when the user asks to run an autonomous boomerang pass with context summarization, or explicitly asks for boomerang mode/rethrows.",
      parameters: Type.Object({
        task: Type.Optional(Type.String({ description: "Task to execute. Supports --rethrow N for multi-pass execution with summaries between rethrows." })),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        if (!toolEnabled) {
          return {
            content: [{ type: "text", text: "Boomerang tool is disabled. User must run `/boomerang tool on` to enable." }],
            details: {},
          };
        }

        if (boomerangActive) {
          return {
            content: [{ type: "text", text: "A boomerang is already active. Wait for it to complete." }],
            details: {},
          };
        }

        const task = (params as { task?: string }).task?.trim();

        if (task) {
          if (!storedCommandCtx) {
            return {
              content: [{ type: "text", text: "No command context. Run any /boomerang command first to initialize." }],
              details: {},
              isError: true,
            };
          }
          if (toolQueuedTask) {
            return {
              content: [{ type: "text", text: "A boomerang task is already queued. Wait for it to start before queueing another task." }],
              details: {},
              isError: true,
            };
          }
          toolQueuedTask = task;
          return {
            content: [{ type: "text", text: `Task queued: "${task}". Will start autonomously when this turn ends.` }],
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
            content: [{ type: "text", text: "Boomerang anchor set. Do your work, then call boomerang again to summarize the context." }],
            details: {},
          };
        }

        toolCollapsePending = true;
        return {
          content: [{ type: "text", text: "Boomerang complete. Context will be summarized when this turn ends." }],
          details: {},
        };
      },
    });
  }

  if (toolEnabled) {
    ensureToolRegistered();
  }

  pi.on("before_agent_start", async (event, ctx) => {
    let systemPrompt = event.systemPrompt;

    if (autoBoomerangCandidate && autoBoomerangEnabled && !boomerangActive && !pendingCollapse && !rethrowState && !chainState && !toolCollapsePending && !toolQueuedTask && !toolAnchorEntryId) {
      const candidate = autoBoomerangCandidate;
      autoBoomerangCandidate = null;
      boomerangActive = true;
      lastTaskSummary = null;
      pendingSkill = null;
      autoAwaitingAssistantAfterId = candidate.targetId;

      if (storedCommandCtx && candidate.targetId !== null) {
        pendingCollapse = { targetId: candidate.targetId, task: candidate.task, commandCtx: storedCommandCtx };
        autoFallbackCollapse = null;
      } else {
        pendingCollapse = null;
        autoFallbackCollapse = { targetId: candidate.targetId, task: candidate.task };
      }

      keepBoomerangExpanded(ctx);
      updateStatus(ctx);
    } else {
      autoBoomerangCandidate = null;
    }

    if (toolEnabled && !boomerangActive) {
      const guidance = toolGuidance
        ? `The boomerang tool is available for token-efficient task execution. ${toolGuidance}`
        : "The boomerang tool is available for token-efficient task execution. Use it for large, multi-step tasks where collapsing context afterward would be beneficial.";
      systemPrompt += `\n\n${guidance}`;
    }

    if (boomerangActive) {
      systemPrompt += "\n\n" + BOOMERANG_INSTRUCTIONS;

      if (rethrowState) {
        systemPrompt += `\n\nRETHROW ${rethrowState.currentRethrow}/${rethrowState.rethrowCount}\nYou are on rethrow ${rethrowState.currentRethrow} of ${rethrowState.rethrowCount}. Previous rethrows made changes that are already applied to the codebase. Build on that work.`;
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
    if (rethrowState) return;

    if (boomerangActive && autoAwaitingAssistantAfterId !== null) {
      const branch = (ctx.sessionManager as SessionManager).getBranch();
      if (!hasAssistantMessageAfterEntry(branch, autoAwaitingAssistantAfterId)) {
        return;
      }
      autoAwaitingAssistantAfterId = null;
    }

    if (boomerangActive && awaitingAssistantForTask !== null) {
      const branch = (ctx.sessionManager as SessionManager).getBranch();
      if (!hasAssistantMessageAfterTask(branch, awaitingAssistantForTask)) {
        return;
      }
      awaitingAssistantForTask = null;
    }

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

    if (toolQueuedTask && storedCommandCtx) {
      const task = toolQueuedTask;
      toolQueuedTask = null;
      await startTask(task, storedCommandCtx, { model: ctx.model, thinking: pi.getThinkingLevel() });
      return;
    }

    if (toolCollapsePending && toolAnchorEntryId) {
      toolCollapsePending = false;

      if (!storedCommandCtx) {
        // Fallback: branchWithSummary then trigger a new turn to pick up summarized context
        const sm = ctx.sessionManager as SessionManager;
        const branch = sm.getBranch();
        const startIndex = branch.findIndex((entry) => entry.id === toolAnchorEntryId);
        const workEntries = startIndex >= 0 ? branch.slice(startIndex + 1) : [];
        const generatedSummary = generateSummaryFromEntries(workEntries, "Agent-initiated task");
        let shouldTriggerHandoff = false;
        try {
          keepBoomerangExpanded(ctx);
          const entryId = sm.branchWithSummary(toolAnchorEntryId, generatedSummary.summary, generatedSummary.details);
          justCollapsedEntryId = entryId;
          ctx.ui.notify("Context summarized (agent sees it; /reload to refresh display)", "info");
          shouldTriggerHandoff = true;
        } catch (err) {
          ctx.ui.notify(`Failed to summarize: ${String(err)}`, "error");
        }
        toolAnchorEntryId = null;
        await restoreModelAndThinking(ctx);
        if (shouldTriggerHandoff) {
          triggerOrchestratorHandoff();
        }
        return;
      }

      // Use navigateTree for immediate UI update
      const targetId = toolAnchorEntryId;
      toolAnchorEntryId = null;
      pendingCollapse = { targetId, task: "Agent-initiated task", commandCtx: storedCommandCtx };

      let shouldTriggerHandoff = false;
      try {
        globalThis.__boomerangCollapseInProgress = true;
        keepBoomerangExpanded(ctx);
        const result = await storedCommandCtx.navigateTree(targetId, { summarize: true });
        if (result.cancelled) {
          ctx.ui.notify("Summary cancelled", "warning");
        } else {
          ctx.ui.notify("Boomerang complete. Context summarized.", "info");
          shouldTriggerHandoff = true;
        }
      } catch (err) {
        ctx.ui.notify(`Failed to summarize: ${String(err)}`, "error");
      } finally {
        globalThis.__boomerangCollapseInProgress = false;
      }
      pendingCollapse = null;
      await restoreModelAndThinking(ctx);
      if (shouldTriggerHandoff) {
        triggerOrchestratorHandoff();
      }
      return;
    }

    if (boomerangActive && autoFallbackCollapse) {
      const fallbackCollapse = autoFallbackCollapse;
      const sm = ctx.sessionManager as SessionManager;
      const branch = sm.getBranch();
      const startIndex = fallbackCollapse.targetId === null
        ? -1
        : branch.findIndex((entry) => entry.id === fallbackCollapse.targetId);
      const workEntries = branch.slice(startIndex + 1);
      const generatedSummary = generateSummaryFromEntries(workEntries, fallbackCollapse.task);
      let shouldTriggerHandoff = false;

      try {
        keepBoomerangExpanded(ctx);
        const entryId = sm.branchWithSummary(fallbackCollapse.targetId, generatedSummary.summary, generatedSummary.details);
        justCollapsedEntryId = entryId;
        ctx.ui.notify("Boomerang complete. Context summarized.", "info");
        shouldTriggerHandoff = true;
      } catch (err) {
        ctx.ui.notify(`Failed to summarize: ${String(err)}`, "error");
      }

      await restoreModelAndThinking(ctx);
      clearTaskState();
      updateStatus(ctx);
      if (shouldTriggerHandoff) {
        triggerOrchestratorHandoff();
      }
      return;
    }

    if (!boomerangActive || !pendingCollapse) return;

    const collapseRequest = pendingCollapse;
    const { targetId, commandCtx } = collapseRequest;

    let shouldTriggerHandoff = false;
    try {
      globalThis.__boomerangCollapseInProgress = true;
      keepBoomerangExpanded(ctx);
      const result = await commandCtx.navigateTree(targetId, { summarize: true });
      const collapseStillOwned = pendingCollapse === collapseRequest && boomerangActive;

      if (result.cancelled) {
        ctx.ui.notify("Summary cancelled", "warning");
      } else if (!collapseStillOwned) {
        // State changed during summarization (for example via /boomerang-cancel).
      } else {
        if (anchorEntryId !== null && targetId === anchorEntryId && lastTaskSummary) {
          anchorSummaries.push(lastTaskSummary);
        }
        ctx.ui.notify("Boomerang complete. Context summarized.", "info");
        shouldTriggerHandoff = true;
      }
    } catch (err) {
      ctx.ui.notify(`Failed to summarize: ${String(err)}`, "error");
    } finally {
      globalThis.__boomerangCollapseInProgress = false;
    }

    await restoreModelAndThinking(ctx);
    clearTaskState();
    updateStatus(ctx);
    if (shouldTriggerHandoff) {
      triggerOrchestratorHandoff();
    }
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

    const activeRethrowState = rethrowState;
    const rethrowInfo = activeRethrowState
      ? { rethrow: activeRethrowState.currentRethrow, totalRethrows: activeRethrowState.rethrowCount }
      : undefined;
    const generatedSummary = generateSummaryFromEntries(entries, pendingCollapse.task, config, rethrowInfo);
    const summaryText = generatedSummary.summary;

    // Save for accumulation after successful summarization (read by runRethrowLoop
    // for rethrows, or by agent_end for anchor accumulation in single boomerangs)
    lastTaskSummary = summaryText;

    // Precedence: rethrow accumulation > user-anchor accumulation > raw summary
    const isRethrowCollapse = activeRethrowState !== null && pendingCollapse.targetId === activeRethrowState.autoAnchorId;
    const isAnchorCollapse =
      !isRethrowCollapse && anchorEntryId !== null && pendingCollapse.targetId === anchorEntryId;

    let finalSummary: string;
    if (isRethrowCollapse && activeRethrowState) {
      finalSummary = [...activeRethrowState.rethrowSummaries, summaryText].join("\n\n---\n\n");
    } else if (isAnchorCollapse) {
      finalSummary = [...anchorSummaries, summaryText].join("\n\n---\n\n");
    } else {
      finalSummary = summaryText;
    }

    return {
      summary: {
        summary: finalSummary,
        details: generatedSummary.details,
      },
    };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (boomerangActive || pendingCollapse || rethrowState || chainState || toolCollapsePending) {
      keepBoomerangExpanded(ctx);
    }

    if (justCollapsedEntryId !== null) {
      const lastEntry = event.branchEntries[event.branchEntries.length - 1];
      const previousEntry = event.branchEntries[event.branchEntries.length - 2];
      const lastIsBoomerangHandoff =
        lastEntry?.type === "custom_message"
        && lastEntry.customType === "boomerang-handoff"
        && lastEntry.display === false;
      if (lastEntry?.id === justCollapsedEntryId || (lastIsBoomerangHandoff && previousEntry?.id === justCollapsedEntryId)) {
        justCollapsedEntryId = null;
        return { cancel: true };
      }
      justCollapsedEntryId = null;
    }
  });

  async function resetForSessionChange(ctx: ExtensionContext): Promise<void> {
    await restoreModelAndThinking(ctx);
    clearState();
    updateStatus(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    await resetForSessionChange(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await resetForSessionChange(ctx);
  });
}
