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

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (chainState) {
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

  function generateSummaryFromEntries(entries: SessionEntry[], task: string, config?: SummaryConfig): string {
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

    let summary = `[BOOMERANG COMPLETE]\nTask: "${task}"`;

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
        if (anchorEntryId !== null && targetId === anchorEntryId && lastTaskSummary) {
          anchorSummaries.push(lastTaskSummary);
        }
        ctx.ui.notify("Boomerang complete. Context collapsed.", "info");
      }
    } catch (err) {
      ctx.ui.notify(`Failed to collapse: ${err}`, "error");
    } finally {
      globalThis.__boomerangCollapseInProgress = false;
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
    const summary = generateSummaryFromEntries(entries, pendingCollapse.task, config);

    // Save for anchor accumulation (used in agent_end after successful collapse)
    lastTaskSummary = summary;

    const isCollapsingToAnchor = anchorEntryId !== null && pendingCollapse.targetId === anchorEntryId;
    const finalSummary = isCollapsingToAnchor
      ? [...anchorSummaries, summary].join("\n\n---\n\n")
      : summary;

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
