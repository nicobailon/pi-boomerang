import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";

const mockState = vi.hoisted(() => ({
  homeDir: "",
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockState.homeDir,
  };
});

import boomerangExtension, { getEffectiveArgs, parseChain, extractRethrow } from "./index.js";

describe("parseChain", () => {
  it("parses basic chains", () => {
    expect(parseChain("/a -> /b")).toEqual({
      steps: [{ templateRef: "a", args: [] }, { templateRef: "b", args: [] }],
      globalArgs: [],
    });
    expect(parseChain("/a -> /b -> /c")?.steps).toHaveLength(3);
  });

  it("parses global args after --", () => {
    const result = parseChain('/a -> /b -- "global"');
    expect(result?.globalArgs).toEqual(["global"]);
    expect(result?.steps[0].args).toEqual([]);
    expect(result?.steps[1].args).toEqual([]);
  });

  it("parses per-step args", () => {
    const result = parseChain('/a "x" "y" -> /b');
    expect(result?.steps[0].args).toEqual(["x", "y"]);
    expect(result?.steps[1].args).toEqual([]);
  });

  it("parses mixed per-step and global args", () => {
    const result = parseChain('/a "inline" -> /b -> /c -- "global"');
    expect(result?.steps[0].args).toEqual(["inline"]);
    expect(result?.steps[1].args).toEqual([]);
    expect(result?.steps[2].args).toEqual([]);
    expect(result?.globalArgs).toEqual(["global"]);
  });

  it("preserves arrow in quoted arg", () => {
    const result = parseChain('/a -> /b "plan -> execute"');
    expect(result?.steps[1].args).toEqual(["plan -> execute"]);
  });

  it("handles subdirectory templates", () => {
    const result = parseChain("/codex/scout -> /codex/plan");
    expect(result?.steps[0].templateRef).toBe("codex/scout");
  });

  it("returns null for non-chain and malformed inputs", () => {
    expect(parseChain("/single")).toBeNull();
    expect(parseChain("/a -> b")).toBeNull();
    expect(parseChain("-> /b")).toBeNull();
    expect(parseChain("/a ->")).toBeNull();
    expect(parseChain("/a -> -> /c")).toBeNull();
    expect(parseChain("/a -- args")).toBeNull();
  });
});

describe("extractRethrow", () => {
  it("extracts a valid --rethrow count", () => {
    expect(extractRethrow("/task --rethrow 3")).toEqual({
      task: "/task",
      rethrowCount: 3,
    });
  });

  it("returns null when no --rethrow flag is present", () => {
    expect(extractRethrow("/task")).toBeNull();
  });

  it("returns empty task when only --rethrow metadata is provided", () => {
    expect(extractRethrow("--rethrow 3")).toEqual({
      task: "",
      rethrowCount: 3,
    });
  });

  it("returns error signal when --rethrow count is missing", () => {
    expect(extractRethrow("/task --rethrow")).toEqual({
      task: "/task",
      rethrowCount: 0,
    });
  });

  it("returns error signal when --rethrow count is zero", () => {
    expect(extractRethrow("/task --rethrow 0")).toEqual({
      task: "/task 0",
      rethrowCount: 0,
    });
  });

  it("returns error signal when --rethrow count is greater than 999", () => {
    expect(extractRethrow("/task --rethrow 1000")).toEqual({
      task: "/task 1000",
      rethrowCount: 0,
    });
  });

  it("preserves quoted args while consuming --rethrow", () => {
    expect(extractRethrow('/task "fix auth bug" --rethrow 2')).toEqual({
      task: '/task "fix auth bug"',
      rethrowCount: 2,
    });
  });

  it("preserves inner spacing inside quoted args", () => {
    expect(extractRethrow('/task "fix   auth   bug" --rethrow 2')).toEqual({
      task: '/task "fix   auth   bug"',
      rethrowCount: 2,
    });
  });

  it("respects -- separator and preserves global args", () => {
    expect(extractRethrow('/a -> /b --rethrow 2 -- "global arg"')).toEqual({
      task: '/a -> /b -- "global arg"',
      rethrowCount: 2,
    });
  });

  it("does not consume --rethrow after standalone --", () => {
    expect(extractRethrow("/task -- --rethrow 2")).toBeNull();
  });

  it("does not consume --loop/--fresh/--no-converge tokens", () => {
    expect(extractRethrow("/task --loop 5 --fresh --no-converge --rethrow 2")).toEqual({
      task: "/task --loop 5 --fresh --no-converge",
      rethrowCount: 2,
    });
  });
});

describe("getEffectiveArgs", () => {
  it("uses step args when present", () => {
    const step = { templateRef: "x", template: { content: "", models: [] }, args: ["a", "b"] };
    expect(getEffectiveArgs(step, ["global"])).toEqual(["a", "b"]);
  });

  it("falls back to global args when step args are empty", () => {
    const step = { templateRef: "x", template: { content: "", models: [] }, args: [] };
    expect(getEffectiveArgs(step, ["global"])).toEqual(["global"]);
  });
});

describe("Boomerang Extension", () => {
  let tempRoot: string;
  let homeDir: string;
  let projectDir: string;
  let currentCwd: string;
  let currentLeafId: string | null;
  let currentModel: { provider: string; id: string };
  let currentThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  let agentIdle: boolean;
  let allModels: { provider: string; id: string }[];
  let availableModels: { provider: string; id: string }[];
  let switchFailures: Set<string>;

  let handlers: Map<string, Function[]>;
  let commands: Map<string, { description: string; handler: Function }>;
  let tools: Map<string, { name: string; execute: Function }>;
  let sentMessages: string[];
  let sentCustomMessages: Array<{ message: { customType: string; content: string; display: boolean }; options: { triggerTurn?: boolean; deliverAs?: string } | undefined }>;
  let sessionEntries: SessionEntry[];
  let navigateTreeCalls: { targetId: string; options: { summarize?: boolean } }[];
  let branchWithSummaryCalls: { targetId: string; summary: string; entryId: string; details?: unknown }[];
  let capturedSummary: { summary: { summary: string; details: { task: string; readFiles: string[]; modifiedFiles: string[]; validationCommands: string[]; failedOperations: string[]; commandCount: number } } } | undefined;
  let setModelCalls: string[];
  let setThinkingCalls: string[];

  let uiMock: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    setToolsExpanded: ReturnType<typeof vi.fn>;
    theme: { fg: (color: string, text: string) => string };
  };
  let isIdleMock: ReturnType<typeof vi.fn>;
  let waitForIdleMock: ReturnType<typeof vi.fn>;
  let mockPi: ExtensionAPI;
  let mockCtx: ExtensionContext;
  let mockCommandCtx: ExtensionCommandContext;

  function model(provider: string, id: string) {
    return { provider, id };
  }

  function modelKey(value: { provider: string; id: string }) {
    return `${value.provider}/${value.id}`;
  }

  function getCommand(name: string) {
    return commands.get(name)!.handler;
  }

  function getHandler(name: string) {
    return handlers.get(name)?.[0];
  }

  function getTool(name: string) {
    return tools.get(name);
  }

  function ensureParent(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  function writeFile(filePath: string, content: string) {
    ensureParent(filePath);
    writeFileSync(filePath, content);
  }

  function promptPath(scope: "user" | "project", ref: string) {
    const base = scope === "project"
      ? join(currentCwd, ".pi", "prompts")
      : join(homeDir, ".pi", "agent", "prompts");
    return `${join(base, ...ref.split("/"))}.md`;
  }

  function skillPath(scope: "user" | "project", skillName: string) {
    const base = scope === "project"
      ? join(currentCwd, ".pi", "skills")
      : join(homeDir, ".pi", "agent", "skills");
    return join(base, skillName, "SKILL.md");
  }

  function writePrompt(scope: "user" | "project", ref: string, content: string) {
    const filePath = promptPath(scope, ref);
    writeFile(filePath, content);
    return filePath;
  }

  function makeUnreadablePrompt(scope: "user" | "project", ref: string) {
    const filePath = promptPath(scope, ref);
    mkdirSync(filePath, { recursive: true });
    return filePath;
  }

  function writeSkill(scope: "user" | "project", name: string, content: string) {
    const filePath = skillPath(scope, name);
    writeFile(filePath, content);
    return filePath;
  }

  function makeUnreadableSkill(scope: "user" | "project", name: string) {
    const filePath = skillPath(scope, name);
    mkdirSync(filePath, { recursive: true });
    return filePath;
  }

  function getConfigPath(): { dir: string; path: string } {
    const dir = join(homeDir, ".pi", "agent");
    return { dir, path: join(dir, "boomerang.json") };
  }

  function addSessionEntry(entry: Omit<SessionEntry, "id">, id = `entry-${sessionEntries.length}`) {
    sessionEntries.push({ id, ...entry });
    currentLeafId = id;
    return id;
  }

  function addAssistantToolEntry(toolName: string, args?: string | Record<string, unknown>) {
    const toolCallId = `tool-${sessionEntries.length}`;
    addSessionEntry({
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: toolCallId,
          name: toolName,
          arguments: typeof args === "string" ? { path: args } : args ?? {},
        }],
      },
      timestamp: new Date().toISOString(),
    });
    return toolCallId;
  }

  function addToolResultEntry(toolName: string, isError: boolean, text: string, toolCallId = `tool-${sessionEntries.length}`) {
    return addSessionEntry({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError,
        timestamp: Date.now(),
      },
      timestamp: new Date().toISOString(),
    });
  }

  function addAssistantTextEntry(text: string) {
    return addSessionEntry({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
      timestamp: new Date().toISOString(),
    });
  }

  function createCommandCtx(overrides: Partial<ExtensionCommandContext> = {}) {
    const navigateTree = vi.fn(async (targetId: string, options: { summarize?: boolean }) => {
      navigateTreeCalls.push({ targetId, options });
      const handler = getHandler("session_before_tree");
      if (handler) {
        const startIndex = sessionEntries.findIndex((entry) => entry.id === targetId);
        const entriesToSummarize = startIndex >= 0 ? sessionEntries.slice(startIndex + 1) : sessionEntries;
        capturedSummary = await handler(
          {
            preparation: {
              targetId,
              oldLeafId: currentLeafId,
              entriesToSummarize,
              userWantsSummary: true,
            },
          },
          mockCtx
        );
      }
      return { cancelled: false };
    });

    return {
      hasUI: true,
      ui: uiMock,
      get cwd() {
        return currentCwd;
      },
      get model() {
        return currentModel;
      },
      modelRegistry: mockCtx.modelRegistry,
      isIdle: isIdleMock,
      waitForIdle: waitForIdleMock,
      sessionManager: mockCtx.sessionManager,
      navigateTree,
      ...overrides,
    } as unknown as ExtensionCommandContext;
  }

  async function runBoomerang(args: string, ctx: ExtensionCommandContext = mockCommandCtx) {
    await getCommand("boomerang")(args, ctx);
  }

  async function runCancel(ctx: ExtensionCommandContext = mockCommandCtx) {
    await getCommand("boomerang-cancel")("", ctx);
  }

  async function fireBeforeAgentStart(systemPrompt = "original") {
    return await getHandler("before_agent_start")({ systemPrompt }, mockCtx);
  }

  async function triggerAgentEnd(ctx: ExtensionContext = mockCtx) {
    agentIdle = true;
    const handler = getHandler("agent_end");
    if (handler) {
      await handler({}, ctx);
    }
  }

  async function fireSessionSwitch() {
    await getHandler("session_start")({ reason: "resume" }, mockCtx);
  }

  function notifyMessages() {
    return uiMock.notify.mock.calls.map(([message, level]: [string, string]) => ({ message, level }));
  }

  function expectBoomerangHandoff(count = 1) {
    expect(sentCustomMessages).toHaveLength(count);
    expect(sentCustomMessages[count - 1]).toEqual({
      message: {
        customType: "boomerang-handoff",
        content: "A boomerang task completed. Read the latest [BOOMERANG COMPLETE] summary and continue from it.",
        display: false,
      },
      options: { triggerTurn: true, deliverAs: "followUp" },
    });
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(process.cwd(), ".tmp-boomerang-"));
    homeDir = join(tempRoot, "home");
    projectDir = join(tempRoot, "project");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    currentCwd = projectDir;
    mockState.homeDir = homeDir;

    handlers = new Map();
    commands = new Map();
    tools = new Map();
    sentMessages = [];
    sentCustomMessages = [];
    sessionEntries = [];
    navigateTreeCalls = [];
    branchWithSummaryCalls = [];
    capturedSummary = undefined;
    setModelCalls = [];
    setThinkingCalls = [];
    switchFailures = new Set();

    currentLeafId = "entry-0";
    currentModel = model("anthropic", "current-model");
    currentThinking = "low";
    allModels = [
      currentModel,
      model("anthropic", "claude-opus-4-6"),
      model("anthropic", "claude-sonnet-4-20250514"),
      model("openrouter", "claude-sonnet-4-20250514"),
      model("openrouter", "gemini-2.5-pro"),
    ];
    availableModels = [...allModels];

    addSessionEntry({
      type: "message",
      message: { role: "user", content: "hello", timestamp: 1000 },
      timestamp: new Date(1000).toISOString(),
    }, "entry-0");

    uiMock = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setToolsExpanded: vi.fn(),
      theme: { fg: (color: string, text: string) => `[${color}]${text}` },
    };

    agentIdle = true;
    isIdleMock = vi.fn(() => agentIdle);
    waitForIdleMock = vi.fn(async () => {
      agentIdle = true;
    });

    mockCtx = {
      hasUI: true,
      ui: uiMock,
      get cwd() {
        return currentCwd;
      },
      get model() {
        return currentModel;
      },
      modelRegistry: {
        find: (provider: string, id: string) => allModels.find((entry) => entry.provider === provider && entry.id === id),
        getAll: () => allModels,
        getAvailable: () => availableModels,
      },
      isIdle: isIdleMock,
      sessionManager: {
        getBranch: () => sessionEntries,
        getLeafId: () => currentLeafId,
        branchWithSummary: vi.fn((targetId: string, summary: string, details?: unknown) => {
          const entryId = `branch-summary-${branchWithSummaryCalls.length}`;
          branchWithSummaryCalls.push({ targetId, summary, entryId, details });
          sessionEntries.push({ id: entryId, type: "branch_summary", summary, details });
          currentLeafId = entryId;
          return entryId;
        }),
      },
    } as unknown as ExtensionContext;

    mockCommandCtx = createCommandCtx();

    mockPi = {
      on: vi.fn((event: string, handler: Function) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      }),
      registerCommand: vi.fn((name: string, options: { description: string; handler: Function }) => commands.set(name, options)),
      registerTool: vi.fn((tool: { name: string; execute: Function }) => tools.set(tool.name, tool)),
      sendUserMessage: vi.fn((content: string) => {
        agentIdle = false;
        sentMessages.push(content);
        addSessionEntry({
          type: "message",
          message: { role: "user", content, timestamp: Date.now() },
          timestamp: new Date().toISOString(),
        });
      }),
      sendMessage: vi.fn((message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
        sentCustomMessages.push({ message, options });
        addSessionEntry({
          type: "custom_message",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        });
      }),
      setModel: vi.fn(async (nextModel: { provider: string; id: string }) => {
        setModelCalls.push(modelKey(nextModel));
        if (switchFailures.has(modelKey(nextModel))) {
          return false;
        }
        currentModel = nextModel;
        return true;
      }),
      getThinkingLevel: vi.fn(() => currentThinking),
      setThinkingLevel: vi.fn((level: typeof currentThinking) => {
        setThinkingCalls.push(level);
        currentThinking = level;
      }),
    } as unknown as ExtensionAPI;

    boomerangExtension(mockPi);
  });

  afterEach(() => {
    delete globalThis.__boomerangCollapseInProgress;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("validation order", () => {
    it("rejects empty task before template processing", async () => {
      await runBoomerang("");

      expect(uiMock.notify).toHaveBeenCalledWith(
        "Usage: /boomerang <task> | anchor | tool [on|off] | guidance [text|clear]",
        "error"
      );
      expect(sentMessages).toEqual([]);
      expect(setModelCalls).toEqual([]);
    });

    it("rejects an active boomerang before template processing", async () => {
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");

      await runBoomerang("regular task");
      await runBoomerang("/commit fix auth");

      expect(uiMock.notify).toHaveBeenLastCalledWith(
        "Boomerang already active. Use /boomerang-cancel to abort.",
        "error"
      );
      expect(setModelCalls).toEqual([]);
    });

    it("rejects a busy agent before template processing", async () => {
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");
      isIdleMock.mockReturnValue(false);

      await runBoomerang("/commit fix auth");

      expect(uiMock.notify).toHaveBeenCalledWith("Agent is busy. Wait for completion first.", "error");
      expect(sentMessages).toEqual([]);
      expect(setModelCalls).toEqual([]);
    });
  });

  describe("template detection", () => {
    it("treats /boomerang /commit as a template reference", async () => {
      writePrompt("user", "commit", "Commit current work.");

      await runBoomerang("/commit");

      expect(sentMessages).toEqual(["Commit current work."]);
    });

    it("treats /boomerang commit as a regular task", async () => {
      writePrompt("user", "commit", "Commit current work.");

      await runBoomerang("commit");

      expect(sentMessages).toEqual(["commit"]);
      expect(setModelCalls).toEqual([]);
    });

    it("reports missing templates", async () => {
      await runBoomerang("/nonexistent");

      expect(uiMock.notify).toHaveBeenCalledWith('Template "nonexistent" not found', "error");
      expect(sentMessages).toEqual([]);
    });

    it("preserves template read errors instead of reporting not found", async () => {
      makeUnreadablePrompt("project", "broken-template");

      await runBoomerang("/broken-template");

      expect(notifyMessages().some(({ message, level }) =>
        level === "error" && message.startsWith('Failed to read template "broken-template":')
      )).toBe(true);
      expect(notifyMessages().some(({ message }) => message === 'Template "broken-template" not found')).toBe(false);
      expect(sentMessages).toEqual([]);
    });
  });

  describe("chain execution", () => {
    it("validates all templates before starting any step", async () => {
      writePrompt("user", "exists", "Exists: $@");

      await runBoomerang("/exists -> /missing -- task");

      expect(uiMock.notify).toHaveBeenCalledWith('Template "missing" not found', "error");
      expect(sentMessages).toEqual([]);
      expect(navigateTreeCalls).toHaveLength(0);
    });

    it("preserves template read errors in chain validation", async () => {
      writePrompt("user", "exists", "Exists: $@");
      makeUnreadablePrompt("project", "broken-template");

      await runBoomerang("/exists -> /broken-template -- task");

      expect(notifyMessages().some(({ message, level }) =>
        level === "error" && message.startsWith('Failed to read template "broken-template":')
      )).toBe(true);
      expect(notifyMessages().some(({ message }) => message === 'Template "broken-template" not found')).toBe(false);
      expect(sentMessages).toEqual([]);
      expect(navigateTreeCalls).toHaveLength(0);
    });

    it("sends messages in step order with effective args", async () => {
      writePrompt("user", "step1", "S1: $@");
      writePrompt("user", "step2", "S2: $@");

      await runBoomerang('/step1 "first" -> /step2 -- "fallback"');
      expect(sentMessages[0]).toBe("S1: first");

      addAssistantTextEntry("Step 1 done");
      await triggerAgentEnd();
      expect(sentMessages[1]).toBe("S2: fallback");
    });

    it("does not advance chain steps before the assistant responds", async () => {
      writePrompt("user", "step1", "Step 1");
      writePrompt("user", "step2", "Step 2");

      await runBoomerang("/step1 -> /step2 -- task");
      await triggerAgentEnd();

      expect(sentMessages).toEqual(["Step 1"]);
      expect(navigateTreeCalls).toHaveLength(0);

      addAssistantTextEntry("Step 1 done");
      await triggerAgentEnd();

      expect(sentMessages).toEqual(["Step 1", "Step 2"]);
    });

    it("summarizes only after the last chain step", async () => {
      writePrompt("user", "step1", "Step 1");
      writePrompt("user", "step2", "Step 2");

      await runBoomerang("/step1 -> /step2 -- task");

      addAssistantTextEntry("Step 1 done");
      await triggerAgentEnd();
      expect(navigateTreeCalls).toHaveLength(0);
      expect(sentMessages).toHaveLength(2);

      addAssistantTextEntry("Step 2 done");
      await triggerAgentEnd();
      expect(navigateTreeCalls).toHaveLength(1);
    });

    it("restores to the original model after a multi-model chain", async () => {
      currentModel = model("anthropic", "current-model");
      writePrompt("user", "step1", "---\nmodel: claude-opus-4-6\n---\nStep one");
      writePrompt("user", "step2", "---\nmodel: claude-sonnet-4-20250514\n---\nStep two");

      await runBoomerang("/step1 -> /step2 -- task");
      addAssistantTextEntry("Step 1 done");
      await triggerAgentEnd();
      addAssistantTextEntry("Step 2 done");
      await triggerAgentEnd();

      expect(setModelCalls).toContain("anthropic/claude-opus-4-6");
      expect(setModelCalls).toContain("anthropic/claude-sonnet-4-20250514");
      expect(setModelCalls[setModelCalls.length - 1]).toBe("anthropic/current-model");
      expect(currentModel).toEqual(model("anthropic", "current-model"));
    });

    it("cancels an active chain and restores model", async () => {
      writePrompt("user", "step1", "---\nmodel: claude-opus-4-6\n---\nStep one");
      writePrompt("user", "step2", "Step two");

      await runBoomerang("/step1 -> /step2 -- task");
      await runCancel();
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(0);
      expect(setModelCalls).toContain("anthropic/current-model");
      expect(currentModel).toEqual(model("anthropic", "current-model"));
    });

    it("clears chain state on session_start", async () => {
      writePrompt("user", "step1", "Step 1");
      writePrompt("user", "step2", "Step 2");

      await runBoomerang("/step1 -> /step2 -- task");
      await getHandler("session_start")({}, mockCtx);
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(0);
      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
    });

    it("rejects malformed chain syntax without sending a message", async () => {
      await runBoomerang("/step1 ->");

      expect(uiMock.notify).toHaveBeenCalledWith(
        "Invalid chain syntax. Use: /template [args] -> /template [args] [-- global args]",
        "error"
      );
      expect(sentMessages).toEqual([]);
    });
  });

  describe("template loading", () => {
    it("loads templates from the user prompt directory", async () => {
      writePrompt("user", "test", "From user");

      await runBoomerang("/test");

      expect(sentMessages).toEqual(["From user"]);
    });

    it("prefers project templates over user templates", async () => {
      writePrompt("user", "test", "From user");
      writePrompt("project", "test", "From project");

      await runBoomerang("/test");

      expect(sentMessages).toEqual(["From project"]);
    });

    it("loads templates from subdirectories", async () => {
      writePrompt("user", "sub/test", "Nested template");

      await runBoomerang("/sub/test");

      expect(sentMessages).toEqual(["Nested template"]);
    });

    it("runs templates without model frontmatter", async () => {
      writePrompt("user", "plain", "No frontmatter needed");

      await runBoomerang("/plain");

      expect(sentMessages).toEqual(["No frontmatter needed"]);
      expect(setModelCalls).toEqual([]);
    });

    it("rejects invalid template refs before file lookup", async () => {
      await runBoomerang("/../secret");

      expect(uiMock.notify).toHaveBeenCalledWith('Template "../secret" not found', "error");
      expect(sentMessages).toEqual([]);
      expect(setModelCalls).toEqual([]);
    });
  });

  describe("model handling", () => {
    it("switches models when a template specifies one", async () => {
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");

      await runBoomerang("/commit fix auth");

      expect(setModelCalls).toEqual(["anthropic/claude-opus-4-6"]);
      expect(currentModel).toEqual(model("anthropic", "claude-opus-4-6"));
    });

    it("restores the previous model after summarizing", async () => {
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");

      await runBoomerang("/commit fix auth");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(currentModel).toEqual(model("anthropic", "current-model"));
      expect(uiMock.notify).toHaveBeenCalledWith("Restored to current-model", "info");
    });

    it("restores the previous model on cancel", async () => {
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");

      await runBoomerang("/commit fix auth");
      await runCancel();

      expect(currentModel).toEqual(model("anthropic", "current-model"));
      expect(uiMock.notify).toHaveBeenCalledWith("Restored to current-model", "info");
    });

    it("warns when restoring previous model fails", async () => {
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");

      await runBoomerang("/commit fix auth");
      switchFailures.add("anthropic/current-model");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(currentModel).toEqual(model("anthropic", "claude-opus-4-6"));
      expect(uiMock.notify).toHaveBeenCalledWith("Failed to restore model:anthropic/current-model", "warning");
      expect(notifyMessages().some(({ message }) => message === "Restored to current-model")).toBe(false);
    });

    it("falls back to the next model when the first switch fails", async () => {
      writePrompt("user", "commit", "---\nmodel: openrouter/gemini-2.5-pro, claude-opus-4-6\n---\nCommit $@");
      switchFailures.add("openrouter/gemini-2.5-pro");

      await runBoomerang("/commit fix auth");

      expect(setModelCalls).toEqual([
        "openrouter/gemini-2.5-pro",
        "anthropic/claude-opus-4-6",
      ]);
      expect(currentModel).toEqual(model("anthropic", "claude-opus-4-6"));
    });

    it("aborts when no models are available", async () => {
      writePrompt("user", "commit", "---\nmodel: openrouter/gemini-2.5-pro, claude-opus-4-6\n---\nCommit $@");
      switchFailures.add("openrouter/gemini-2.5-pro");
      switchFailures.add("anthropic/claude-opus-4-6");

      await runBoomerang("/commit fix auth");

      expect(uiMock.notify).toHaveBeenCalledWith(
        "No available model from: openrouter/gemini-2.5-pro, claude-opus-4-6",
        "error"
      );
      expect(sentMessages).toEqual([]);
    });

    it("does not switch or restore when the template model is already active", async () => {
      currentModel = model("anthropic", "claude-opus-4-6");
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");

      await runBoomerang("/commit fix auth");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(setModelCalls).toEqual([]);
      expect(notifyMessages().some(({ message }) => message.includes("Restored to"))).toBe(false);
    });
  });

  describe("skill handling", () => {
    it("injects a resolved skill into the system prompt", async () => {
      writePrompt("user", "commit", "---\nskill: git-workflow\n---\nCommit $@");
      writeSkill("project", "git-workflow", "---\ndescription: Git help\n---\nUse careful git commits.");

      await runBoomerang("/commit fix auth");
      const result = await fireBeforeAgentStart();

      expect(result.systemPrompt).toContain("BOOMERANG MODE ACTIVE");
      expect(result.systemPrompt).toContain('<skill name="git-workflow">');
      expect(result.systemPrompt).toContain("Use careful git commits.");
      expect(uiMock.notify).toHaveBeenCalledWith('Skill "git-workflow" loaded', "info");
    });

    it("warns and continues when a skill is missing", async () => {
      writePrompt("user", "commit", "---\nskill: missing-skill\n---\nCommit $@");

      await runBoomerang("/commit fix auth");
      const result = await fireBeforeAgentStart();

      expect(uiMock.notify).toHaveBeenCalledWith('Skill "missing-skill" not found', "warning");
      expect(sentMessages).toEqual(["Commit fix auth"]);
      expect(result.systemPrompt).not.toContain("<skill");
    });

    it("warns and preserves details when a skill file cannot be read", async () => {
      writePrompt("user", "commit", "---\nskill: broken-skill\n---\nCommit $@");
      makeUnreadableSkill("project", "broken-skill");

      await runBoomerang("/commit fix auth");
      const result = await fireBeforeAgentStart();

      expect(notifyMessages().some(({ message, level }) =>
        level === "warning" && message.startsWith('Failed to read skill "broken-skill":')
      )).toBe(true);
      expect(sentMessages).toEqual(["Commit fix auth"]);
      expect(result.systemPrompt).not.toContain("<skill");
    });
  });

  describe("thinking level handling", () => {
    it("switches thinking levels from template frontmatter", async () => {
      writePrompt("user", "deep-dive", "---\nthinking: xhigh\n---\nInspect $@");

      await runBoomerang("/deep-dive auth");

      expect(setThinkingCalls).toEqual(["xhigh"]);
      expect(currentThinking).toBe("xhigh");
    });

    it("restores the previous thinking level after summarizing", async () => {
      writePrompt("user", "deep-dive", "---\nthinking: xhigh\n---\nInspect $@");

      await runBoomerang("/deep-dive auth");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(currentThinking).toBe("low");
      expect(uiMock.notify).toHaveBeenCalledWith("Restored to thinking:low", "info");
    });

    it("restores the previous thinking level on cancel", async () => {
      writePrompt("user", "deep-dive", "---\nthinking: xhigh\n---\nInspect $@");

      await runBoomerang("/deep-dive auth");
      await runCancel();

      expect(currentThinking).toBe("low");
      expect(uiMock.notify).toHaveBeenCalledWith("Restored to thinking:low", "info");
    });

    it("skips thinking changes and restore when the level already matches", async () => {
      currentThinking = "high";
      writePrompt("user", "deep-dive", "---\nthinking: high\n---\nInspect $@");

      await runBoomerang("/deep-dive auth");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(setThinkingCalls).toEqual([]);
      expect(notifyMessages().some(({ message }) => message.includes("thinking:"))).toBe(false);
    });
  });

  describe("argument substitution", () => {
    it("replaces $@ with all arguments", async () => {
      writePrompt("user", "args", "All: $@");

      await runBoomerang("/args one two three");

      expect(sentMessages).toEqual(["All: one two three"]);
    });

    it("replaces positional arguments", async () => {
      writePrompt("user", "args", "$2 then $1");

      await runBoomerang("/args first second");

      expect(sentMessages).toEqual(["second then first"]);
    });

    it("replaces $ARGUMENTS with all arguments", async () => {
      writePrompt("user", "args", "Args: $ARGUMENTS");

      await runBoomerang("/args alpha beta");

      expect(sentMessages).toEqual(["Args: alpha beta"]);
    });

    it("supports @$ alias for all arguments", async () => {
      writePrompt("user", "args", "Args: @$");

      await runBoomerang("/args alpha beta");

      expect(sentMessages).toEqual(["Args: alpha beta"]);
    });

    it("preserves quoted arguments", async () => {
      writePrompt("user", "args", "$1|$2|$3");

      await runBoomerang('/args "fix auth bug" module "with tests"');

      expect(sentMessages).toEqual(["fix auth bug|module|with tests"]);
    });

    it("allows empty expanded templates", async () => {
      writePrompt("user", "empty", "$1");

      await runBoomerang("/empty");

      expect(sentMessages).toEqual([""]);
    });
  });

  describe("summary generation", () => {
    it("uses the template reference instead of the expanded content in the summary", async () => {
      writePrompt("user", "review", "Expanded prompt body");

      await runBoomerang("/review");
      addAssistantToolEntry("edit", "src/auth.ts");
      await triggerAgentEnd();

      expect(capturedSummary.summary.summary).toContain('Task: "/review"');
      expect(capturedSummary.summary.summary).not.toContain("Expanded prompt body");
    });

    it("includes template arguments in the summary task label", async () => {
      writePrompt("user", "commit", "Commit $@");

      await runBoomerang("/commit fix the bug");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(capturedSummary.summary.summary).toContain('Task: "/commit fix the bug"');
    });

    it("includes the agent's final text in the summary as Outcome", async () => {
      await runBoomerang("fix the auth bug");
      addAssistantTextEntry("I completed the task successfully. The auth module is now fixed.");
      await triggerAgentEnd();

      expect(capturedSummary.summary.summary).toContain("Outcome:");
      expect(capturedSummary.summary.summary).toContain("I completed the task successfully");
    });

    it("includes operational handoff sections when tools are used and text is returned", async () => {
      await runBoomerang("fix auth");
      addAssistantToolEntry("read", "src/auth.ts");
      addAssistantToolEntry("edit", "src/auth.ts");
      addAssistantToolEntry("bash", { command: "npm test" });
      addAssistantTextEntry("Fixed the authentication bug by updating the JWT validation.");
      await triggerAgentEnd();

      const summary = capturedSummary.summary.summary;
      expect(summary).toContain("Outcome:\nFixed the authentication bug");
      expect(summary).toContain("Changed Files:\n- src/auth.ts");
      expect(summary).not.toContain("Relevant Reads:\n- src/auth.ts");
      expect(summary).toContain("Commands:\n- Ran 1 command(s)");
      expect(summary).toContain("- Validation: `npm test`");
      expect(summary).toContain("- Failures: none detected");
      expect(capturedSummary.summary.details.modifiedFiles).toEqual(["src/auth.ts"]);
      expect(capturedSummary.summary.details.validationCommands).toEqual(["npm test"]);
    });

    it("keeps full long agent responses in the summary", async () => {
      const longText = "A".repeat(600);
      await runBoomerang("do something");
      addAssistantTextEntry(longText);
      await triggerAgentEnd();

      expect(capturedSummary.summary.summary).toContain("Outcome:");
      expect(capturedSummary.summary.summary).toContain(longText);
    });

    it("includes Config block when template switched model, thinking, or skill", async () => {
      writePrompt("user", "full-config", "---\nmodel: claude-opus-4-6\nskill: git-workflow\nthinking: high\n---\nDo the task");
      writeSkill("user", "git-workflow", "Git skill content");

      await runBoomerang("/full-config");
      addAssistantTextEntry("Task completed.");
      await triggerAgentEnd();

      expect(capturedSummary.summary.summary).toContain("Config:\n- model: claude-opus-4-6");
      expect(capturedSummary.summary.summary).toContain("- thinking: high");
      expect(capturedSummary.summary.summary).toContain("- skill: git-workflow");
    });

    it("preserves raw quoted template args in rethrow summaries", async () => {
      writePrompt("user", "task", "Task $@");

      await runBoomerang('/task "fix auth bug" --rethrow 1');

      expect(capturedSummary?.summary.summary).toContain('Task: "/task "fix auth bug""');
      expect(capturedSummary?.summary.summary).toContain("[BOOMERANG COMPLETE - RETHROW 1/1]");
    });

    it("non-rethrow boomerangs use [BOOMERANG COMPLETE] header without RETHROW label", async () => {
      await runBoomerang("some task");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(capturedSummary.summary.summary).toContain("[BOOMERANG COMPLETE]");
      expect(capturedSummary.summary.summary).not.toContain("RETHROW");
    });

    it("includes relevant read-only files and failed operations", async () => {
      await runBoomerang("investigate auth");
      addAssistantToolEntry("read", "src/auth.ts");
      addAssistantToolEntry("read", "src/session.ts");
      const bashToolCallId = addAssistantToolEntry("bash", { command: "git diff --check" });
      addToolResultEntry("bash", true, "trailing whitespace in src/auth.ts", bashToolCallId);
      addAssistantTextEntry("Found formatting issue but did not edit files.");
      await triggerAgentEnd();

      const summary = capturedSummary.summary.summary;
      expect(summary).toContain("Changed Files:\n- None");
      expect(summary).toContain("Relevant Reads:\n- src/auth.ts\n- src/session.ts");
      expect(summary).toContain("- Validation: `git diff --check`");
      expect(summary).toContain("- Failures: bash `git diff --check`: trailing whitespace in src/auth.ts");
      expect(capturedSummary.summary.details.readFiles).toEqual(["src/auth.ts", "src/session.ts"]);
      expect(capturedSummary.summary.details.failedOperations).toEqual(["bash `git diff --check`: trailing whitespace in src/auth.ts"]);
    });
  });

  describe("rethrow command handler", () => {
    it("runs template rethrows with --rethrow N", async () => {
      writePrompt("user", "task", "Task content");

      await runBoomerang("/task --rethrow 2");

      expect(sentMessages).toEqual(["Task content", "Task content"]);
      expect(navigateTreeCalls).toHaveLength(2);
      expect(uiMock.notify).toHaveBeenCalledWith("Rethrow started: 2 iterations", "info");
      expect(uiMock.notify).toHaveBeenCalledWith("Rethrow complete: 2/2", "info");
      expectBoomerangHandoff();
    });

    it("treats --loop N as a rethrow alias for boomerang templates", async () => {
      writePrompt("user", "task", "Task $@");

      await runBoomerang("/task fix auth --loop 2");

      expect(sentMessages).toEqual(["Task fix auth", "Task fix auth"]);
      expect(navigateTreeCalls).toHaveLength(2);
      expect(sentMessages.every((msg) => !msg.includes("--loop"))).toBe(true);
      expect(uiMock.notify).toHaveBeenCalledWith("Mapped --loop to boomerang --rethrow 2.", "info");
    });

    it("strips --loop tokens when --rethrow is already set", async () => {
      writePrompt("user", "task", "Task $@");

      await runBoomerang("/task fix auth --rethrow 2 --loop 3");

      expect(sentMessages).toEqual(["Task fix auth", "Task fix auth"]);
      expect(sentMessages.every((msg) => !msg.includes("--loop"))).toBe(true);
      expect(uiMock.notify).toHaveBeenCalledWith(
        "Ignored --loop because --rethrow is set. Using --rethrow 2.",
        "info"
      );
    });

    it("strips invalid numeric --loop counts when --rethrow is already set", async () => {
      writePrompt("user", "task", "Task $@");

      await runBoomerang("/task fix auth --rethrow 2 --loop 0");

      expect(sentMessages).toEqual(["Task fix auth", "Task fix auth"]);
      expect(sentMessages.every((msg) => !msg.includes(" 0"))).toBe(true);
      expect(uiMock.notify).toHaveBeenCalledWith(
        "Ignored --loop because --rethrow is set. Using --rethrow 2.",
        "info"
      );
    });

    it("strips all repeated --loop tokens when --rethrow is already set", async () => {
      writePrompt("user", "task", "Task $@");

      await runBoomerang("/task fix auth --rethrow 2 --loop 0 --loop 3");

      expect(sentMessages).toEqual(["Task fix auth", "Task fix auth"]);
      expect(sentMessages.every((msg) => !msg.includes("--loop"))).toBe(true);
      expect(sentMessages.every((msg) => !msg.includes(" 0"))).toBe(true);
      expect(uiMock.notify).toHaveBeenCalledWith(
        "Ignored --loop because --rethrow is set. Using --rethrow 2.",
        "info"
      );
    });

    it("runs chain rethrows with global args", async () => {
      writePrompt("user", "scout", "Scout: $@");
      writePrompt("user", "impl", "Impl: $@");

      await runBoomerang('/scout -> /impl --rethrow 2 -- "task"');

      expect(sentMessages).toEqual([
        "Scout: task",
        "Impl: task",
        "Scout: task",
        "Impl: task",
      ]);
      expect(navigateTreeCalls).toHaveLength(2);
    });

    it("runs plain task rethrows", async () => {
      await runBoomerang("plain task --rethrow 2");

      expect(sentMessages).toEqual(["plain task", "plain task"]);
      expect(navigateTreeCalls).toHaveLength(2);
    });

    it("restores model correctly even with a stale command-context model snapshot", async () => {
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");
      const staleCtx = createCommandCtx({
        model: model("anthropic", "current-model"),
      });

      await runBoomerang("/commit fix auth --rethrow 1", staleCtx);

      expect(currentModel).toEqual(model("anthropic", "current-model"));
      expect(setModelCalls).toEqual([
        "anthropic/claude-opus-4-6",
        "anthropic/current-model",
      ]);
    });

    it("shows usage error for --rethrow without a task", async () => {
      await runBoomerang("--rethrow 3");

      expect(sentMessages).toHaveLength(0);
      expect(uiMock.notify).toHaveBeenCalledWith("Usage: /boomerang <task> [--rethrow N]", "error");
    });

    it("shows error for missing --rethrow count", async () => {
      await runBoomerang("/task --rethrow");

      expect(sentMessages).toHaveLength(0);
      expect(uiMock.notify).toHaveBeenCalledWith("--rethrow requires a count (1-999)", "error");
    });

    it("shows error for missing --loop count", async () => {
      await runBoomerang("/task --loop");

      expect(sentMessages).toHaveLength(0);
      expect(uiMock.notify).toHaveBeenCalledWith("--loop requires a count (1-999)", "error");
    });

    it("rejects malformed chain syntax after rethrow metadata is removed", async () => {
      await runBoomerang("/task -> --rethrow 2");

      expect(sentMessages).toHaveLength(0);
      expect(uiMock.notify).toHaveBeenCalledWith(
        "Invalid chain syntax. Use: /template [args] -> /template [args] [-- global args]",
        "error"
      );
    });

    it("preserves template read errors during rethrow runs", async () => {
      makeUnreadablePrompt("project", "broken-template");

      await runBoomerang("/broken-template --rethrow 2");

      expect(notifyMessages().some(({ message, level }) =>
        level === "error" && message.startsWith('Failed to read template "broken-template":')
      )).toBe(true);
      expect(notifyMessages().some(({ message }) => message === 'Template "broken-template" not found')).toBe(false);
      expect(sentMessages).toEqual([]);
      expect(navigateTreeCalls).toHaveLength(0);
    });

    it("non-rethrow command /boomerang /task still works", async () => {
      writePrompt("user", "task", "Task content");
      await runBoomerang("/task");

      expect(sentMessages).toEqual(["Task content"]);
      expect(uiMock.notify).toHaveBeenCalledWith("Boomerang started. Agent will work autonomously.", "info");
    });
  });

  describe("rethrow accumulation and cleanup", () => {
    it("user-anchor summary still works when no rethrow is active", async () => {
      writePrompt("user", "task1", "Task 1");
      const anchorId = currentLeafId;

      await runBoomerang("anchor");
      await runBoomerang("/task1");
      addAssistantTextEntry("Task 1 done");
      await triggerAgentEnd();

      expect(navigateTreeCalls[0].targetId).toBe(anchorId);
      expect(navigateTreeCalls.length).toBe(1);
    });

    it("clears active rethrow state on session_start", async () => {
      writePrompt("user", "task", "Task");
      let releaseWaitForIdle: (() => void) | null = null;
      waitForIdleMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseWaitForIdle = () => {
          agentIdle = true;
          resolve();
        };
      }));

      const running = runBoomerang("/task --rethrow 2");
      await Promise.resolve();
      await getHandler("session_start")({}, mockCtx);
      releaseWaitForIdle?.();
      await running;

      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
    });

    it("clears active rethrow state on /boomerang-cancel", async () => {
      writePrompt("user", "task", "Task");
      let releaseWaitForIdle: (() => void) | null = null;
      waitForIdleMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseWaitForIdle = () => {
          agentIdle = true;
          resolve();
        };
      }));

      const running = runBoomerang("/task --rethrow 2");
      await Promise.resolve();
      await runCancel(mockCommandCtx);
      releaseWaitForIdle?.();
      await running;

      expect(uiMock.notify).toHaveBeenCalledWith("Boomerang cancelled", "info");
    });

    it("accumulates rethrow summaries into a combined summary", async () => {
      writePrompt("user", "task", "Task");
      let callCount = 0;
      waitForIdleMock.mockImplementation(async () => {
        callCount++;
        addAssistantTextEntry(`iteration ${callCount}`);
        agentIdle = true;
      });

      await runBoomerang("/task --rethrow 2");

      expect(capturedSummary?.summary.summary).toContain("[BOOMERANG COMPLETE - RETHROW 1/2]");
      expect(capturedSummary?.summary.summary).toContain("[BOOMERANG COMPLETE - RETHROW 2/2]");
      expect(capturedSummary?.summary.summary).toContain("\n\n---\n\n");
    });

    it("uses rethrow accumulation precedence when user anchor and auto-anchor overlap", async () => {
      writePrompt("user", "task", "Task");
      writePrompt("user", "followup", "Follow-up");
      let callCount = 0;
      waitForIdleMock.mockImplementation(async () => {
        callCount++;
        addAssistantTextEntry(`run ${callCount}`);
        agentIdle = true;
      });

      await runBoomerang("anchor");
      await runBoomerang("/task --rethrow 1");
      await runBoomerang("/followup");
      addAssistantTextEntry("Follow-up done");
      await triggerAgentEnd();

      expect(capturedSummary?.summary.summary).not.toContain("[BOOMERANG COMPLETE - RETHROW 1/1]");
    });

    it("stops rethrows when summarization is cancelled", async () => {
      writePrompt("user", "task", "Task");
      const cancellingCtx = createCommandCtx({
        navigateTree: vi.fn(async (targetId: string, options: { summarize?: boolean }) => {
          navigateTreeCalls.push({ targetId, options });
          return { cancelled: true };
        }),
      });

      await runBoomerang("/task --rethrow 3", cancellingCtx);

      expect(sentMessages).toHaveLength(1);
      expect(navigateTreeCalls).toHaveLength(1);
      expect(uiMock.notify).toHaveBeenCalledWith("Summary cancelled", "warning");
      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
      expect(sentCustomMessages).toEqual([]);
    });
  });

  describe("rethrow execution", () => {
    it("runs multiple rethrows synchronously with waitForIdle", async () => {
      writePrompt("user", "task", "Task");
      let callCount = 0;
      waitForIdleMock.mockImplementation(async () => {
        callCount++;
        addAssistantTextEntry(`done ${callCount}`);
        agentIdle = true;
      });

      await runBoomerang("/task --rethrow 3");

      expect(sentMessages).toHaveLength(3);
      expect(navigateTreeCalls).toHaveLength(3);
      expect(uiMock.notify).toHaveBeenCalledWith("Rethrow 1/3 summarized", "info");
      expect(uiMock.notify).toHaveBeenCalledWith("Rethrow 2/3 summarized", "info");
      expect(uiMock.notify).toHaveBeenCalledWith("Rethrow 3/3 summarized", "info");
      expect(uiMock.notify).toHaveBeenCalledWith("Rethrow complete: 3/3", "info");
    });

    it("supports canceling mid-rethrow", async () => {
      writePrompt("user", "task", "Task");
      const waitResolvers: Array<() => void> = [];
      waitForIdleMock.mockImplementation(() => new Promise<void>((resolve) => {
        waitResolvers.push(() => {
          agentIdle = true;
          resolve();
        });
      }));

      const running = runBoomerang("/task --rethrow 3");
      await Promise.resolve();
      waitResolvers[0]?.();
      while (waitResolvers.length < 2) {
        await Promise.resolve();
      }
      await runCancel();
      waitResolvers[1]?.();
      await running;

      expect(sentMessages).toHaveLength(2);
      expect(navigateTreeCalls).toHaveLength(1);
    });

    it("stops when cancelled before a rethrow turn starts", async () => {
      writePrompt("user", "task", "Task");
      (mockPi.sendUserMessage as ReturnType<typeof vi.fn>).mockImplementation((content: string) => {
        sentMessages.push(content);
        addSessionEntry({
          type: "message",
          message: { role: "user", content, timestamp: Date.now() },
          timestamp: new Date().toISOString(),
        });
      });

      const running = runBoomerang("/task --rethrow 2");
      await Promise.resolve();
      await runCancel();

      await Promise.race([
        running,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for rethrow cancel")), 200)),
      ]);

      expect(navigateTreeCalls).toHaveLength(0);
    });

    it("stops immediately when cancelled during model switching", async () => {
      writePrompt("user", "task", "---\nmodel: claude-opus-4-6\nskill: git-workflow\n---\nTask");
      writeSkill("project", "git-workflow", "Use git skill");

      let releaseModelSwitch: (() => void) | null = null;
      (mockPi.setModel as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (nextModel: { provider: string; id: string }) => new Promise<boolean>((resolve) => {
          setModelCalls.push(modelKey(nextModel));
          releaseModelSwitch = () => {
            currentModel = nextModel;
            resolve(true);
          };
        })
      );

      const running = runBoomerang("/task --rethrow 2");
      while (!releaseModelSwitch) {
        await Promise.resolve();
      }

      await runCancel();
      releaseModelSwitch?.();
      await running;

      expect(sentMessages).toHaveLength(0);
      expect(navigateTreeCalls).toHaveLength(0);
    });

    it("runs all chain steps for each rethrow", async () => {
      writePrompt("user", "scout", "Scout: $@");
      writePrompt("user", "impl", "Impl: $@");

      await runBoomerang('/scout -> /impl --rethrow 2 -- "auth module"');

      expect(sentMessages).toEqual([
        "Scout: auth module",
        "Impl: auth module",
        "Scout: auth module",
        "Impl: auth module",
      ]);
      expect(navigateTreeCalls).toHaveLength(2);
    });

    it("agent_end is a no-op while a rethrow is active", async () => {
      writePrompt("user", "task", "Task");
      let releaseWaitForIdle: (() => void) | null = null;
      waitForIdleMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseWaitForIdle = () => {
          agentIdle = true;
          resolve();
        };
      }));

      const running = runBoomerang("/task --rethrow 2");
      await Promise.resolve();
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(0);
      expect(sentMessages).toHaveLength(1);

      releaseWaitForIdle?.();
      await running;
    });

    it("reloads template content on each rethrow", async () => {
      const templateFile = writePrompt("user", "task", "V1 $@");
      let callCount = 0;
      waitForIdleMock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          writeFileSync(templateFile, "V2 $@");
        }
        agentIdle = true;
      });

      await runBoomerang("/task alpha --rethrow 2");

      expect(sentMessages).toEqual(["V1 alpha", "V2 alpha"]);
    });

    it("injects rethrow prompt context in before_agent_start for each turn", async () => {
      writePrompt("user", "task", "Task");
      const prompts: string[] = [];
      waitForIdleMock.mockImplementation(async () => {
        const beforeStart = await fireBeforeAgentStart("original");
        prompts.push(beforeStart?.systemPrompt ?? "original");
        agentIdle = true;
      });

      await runBoomerang("/task --rethrow 2");

      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("RETHROW 1/2");
      expect(prompts[1]).toContain("RETHROW 2/2");
    });
  });

  describe("integration behavior", () => {
    it("does not summarize before the assistant responds", async () => {
      writePrompt("user", "task", "---\nmodel: claude-opus-4-6\n---\nTask content");

      await runBoomerang("/task");
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(0);

      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(1);
    });

    it("waits for assistant output even if getLeafId becomes null after queueing", async () => {
      writePrompt("user", "task", "Task content");
      const baseSessionManager = mockCtx.sessionManager as any;
      let leafCalls = 0;
      const flakyCtx = createCommandCtx({
        sessionManager: {
          ...baseSessionManager,
          getLeafId: () => {
            leafCalls++;
            return leafCalls <= 2 ? currentLeafId : null;
          },
        } as any,
      });

      await runBoomerang("/task", flakyCtx);
      await triggerAgentEnd();
      expect(navigateTreeCalls).toHaveLength(0);

      addAssistantTextEntry("Done.");
      await triggerAgentEnd();
      expect(navigateTreeCalls).toHaveLength(1);
    });

    it("works with anchor mode across multiple template tasks", async () => {
      writePrompt("user", "commit", "Commit $@");
      writePrompt("user", "code-review", "Review $@");
      const anchorId = currentLeafId;

      await runBoomerang("anchor");
      await runBoomerang("/commit fix auth");
      addAssistantTextEntry("Commit done");
      await triggerAgentEnd();
      await runBoomerang("/code-review auth module");
      addAssistantTextEntry("Review done");
      await triggerAgentEnd();
      await runBoomerang("anchor show");

      expect(navigateTreeCalls[0].targetId).toBe(anchorId);
      expect(navigateTreeCalls[1].targetId).toBe(anchorId);
      expect(uiMock.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("2 task(s) completed"),
        "info"
      );
    });

    it("runs normally when the template model is already active", async () => {
      currentModel = model("anthropic", "claude-opus-4-6");
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");

      await runBoomerang("/commit fix auth");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(sentMessages).toEqual(["Commit fix auth"]);
      expect(navigateTreeCalls).toHaveLength(1);
      expect(currentModel).toEqual(model("anthropic", "claude-opus-4-6"));
    });

    it("keeps boomerang details expanded from task start", async () => {
      await runBoomerang("fix auth");

      expect(uiMock.setToolsExpanded).toHaveBeenCalledWith(true);
    });

    it("expands before summary navigation creates summary rows", async () => {
      let expandedBeforeNavigation = false;
      const trackingCtx = createCommandCtx({
        navigateTree: vi.fn(async (targetId: string, options: { summarize?: boolean }) => {
          expandedBeforeNavigation = uiMock.setToolsExpanded.mock.calls.some(([expanded]) => expanded === true);
          navigateTreeCalls.push({ targetId, options });
          return { cancelled: false };
        }),
      });

      await runBoomerang("fix auth", trackingCtx);
      uiMock.setToolsExpanded.mockClear();
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(expandedBeforeNavigation).toBe(true);
    });

    it("expands before compaction rows are created while boomerang is active", async () => {
      await runBoomerang("fix auth");
      uiMock.setToolsExpanded.mockClear();

      const event: SessionBeforeCompactEvent = {
        type: "session_before_compact",
        branchEntries: sessionEntries,
        preparation: {
          firstKeptEntryId: currentLeafId ?? "entry-0",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 0,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: DEFAULT_COMPACTION_SETTINGS,
        },
        signal: new AbortController().signal,
      };

      await getHandler("session_before_compact")(event, mockCtx);

      expect(uiMock.setToolsExpanded).toHaveBeenCalledWith(true);
    });

    it("wakes the orchestrator with a hidden handoff after successful return", async () => {
      await runBoomerang("fix auth");
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expectBoomerangHandoff();
    });

    it("does not wake the orchestrator when normal summarization is cancelled", async () => {
      const cancellingCtx = createCommandCtx({
        navigateTree: vi.fn(async (targetId: string, options: { summarize?: boolean }) => {
          navigateTreeCalls.push({ targetId, options });
          return { cancelled: true };
        }),
      });

      await runBoomerang("fix auth", cancellingCtx);
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(uiMock.notify).toHaveBeenCalledWith("Summary cancelled", "warning");
      expect(sentCustomMessages).toEqual([]);
    });

    it("does not wake the orchestrator when normal summarization throws", async () => {
      const throwingCtx = createCommandCtx({
        navigateTree: vi.fn(async (targetId: string, options: { summarize?: boolean }) => {
          navigateTreeCalls.push({ targetId, options });
          throw new Error("navigation failed");
        }),
      });

      await runBoomerang("fix auth", throwingCtx);
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(uiMock.notify).toHaveBeenCalledWith("Failed to summarize: Error: navigation failed", "error");
      expect(sentCustomMessages).toEqual([]);
    });

    it("sets the global summarize flag during template summarization", async () => {
      writePrompt("user", "commit", "Commit $@");
      let flagDuringNavigation: boolean | undefined;
      const trackingCtx = createCommandCtx({
        navigateTree: vi.fn(async (targetId: string, options: { summarize?: boolean }) => {
          flagDuringNavigation = globalThis.__boomerangCollapseInProgress;
          navigateTreeCalls.push({ targetId, options });
          return { cancelled: false };
        }),
      });

      await runBoomerang("/commit fix auth", trackingCtx);
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(flagDuringNavigation).toBe(true);
      expect(globalThis.__boomerangCollapseInProgress).toBeFalsy();
    });

    it("restores model and thinking when the session switches mid-boomerang", async () => {
      writePrompt("user", "deep-dive", "---\nmodel: claude-opus-4-6\nthinking: xhigh\n---\nInspect $@");

      await runBoomerang("/deep-dive auth");
      await fireSessionSwitch();

      expect(currentModel).toEqual(model("anthropic", "current-model"));
      expect(currentThinking).toBe("low");
      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
      expect(uiMock.notify).toHaveBeenCalledWith("Restored to current-model, thinking:low", "info");
    });

    it("keeps tool-initiated summary flow working", async () => {
      await runBoomerang("tool on");

      const tool = getTool("boomerang");
      await tool.execute("id-1", {}, undefined, undefined, mockCtx);
      addAssistantTextEntry("tool work");
      await tool.execute("id-2", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(1);
      expect(navigateTreeCalls[0].options).toEqual({ summarize: true });
      expectBoomerangHandoff();
    });

    it("does not wake the orchestrator when stored-context tool summarization is cancelled", async () => {
      const cancellingCtx = createCommandCtx({
        navigateTree: vi.fn(async (targetId: string, options: { summarize?: boolean }) => {
          navigateTreeCalls.push({ targetId, options });
          return { cancelled: true };
        }),
      });
      await runBoomerang("tool on", cancellingCtx);

      const tool = getTool("boomerang");
      await tool.execute("id-1", {}, undefined, undefined, mockCtx);
      addAssistantTextEntry("tool work");
      await tool.execute("id-2", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();

      expect(uiMock.notify).toHaveBeenCalledWith("Summary cancelled", "warning");
      expect(sentCustomMessages).toEqual([]);
    });

    it("does not wake the orchestrator when stored-context tool summarization throws", async () => {
      const throwingCtx = createCommandCtx({
        navigateTree: vi.fn(async (targetId: string, options: { summarize?: boolean }) => {
          navigateTreeCalls.push({ targetId, options });
          throw new Error("tool navigation failed");
        }),
      });
      await runBoomerang("tool on", throwingCtx);

      const tool = getTool("boomerang");
      await tool.execute("id-1", {}, undefined, undefined, mockCtx);
      addAssistantTextEntry("tool work");
      await tool.execute("id-2", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();

      expect(uiMock.notify).toHaveBeenCalledWith("Failed to summarize: Error: tool navigation failed", "error");
      expect(sentCustomMessages).toEqual([]);
    });

    it("cancels compaction after fallback summary followed by hidden handoff", async () => {
      await runBoomerang("tool on");
      await fireSessionSwitch();

      const tool = getTool("boomerang");
      await tool.execute("id-1", {}, undefined, undefined, mockCtx);
      addAssistantTextEntry("tool work");
      await tool.execute("id-2", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();

      expect(branchWithSummaryCalls).toHaveLength(1);
      expect(sessionEntries[sessionEntries.length - 2]?.id).toBe(branchWithSummaryCalls[0].entryId);
      expect(sessionEntries[sessionEntries.length - 1]?.type).toBe("custom_message");

      const event: SessionBeforeCompactEvent = {
        type: "session_before_compact",
        branchEntries: sessionEntries,
        preparation: {
          firstKeptEntryId: currentLeafId ?? "entry-0",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 0,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: DEFAULT_COMPACTION_SETTINGS,
        },
        signal: new AbortController().signal,
      };

      await expect(getHandler("session_before_compact")(event, mockCtx)).resolves.toEqual({ cancel: true });
    });

    it("does not cancel compaction after unrelated entries follow the fallback handoff", async () => {
      await runBoomerang("tool on");
      await fireSessionSwitch();

      const tool = getTool("boomerang");
      await tool.execute("id-1", {}, undefined, undefined, mockCtx);
      addAssistantTextEntry("tool work");
      await tool.execute("id-2", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();
      addAssistantTextEntry("later work");

      const event: SessionBeforeCompactEvent = {
        type: "session_before_compact",
        branchEntries: sessionEntries,
        preparation: {
          firstKeptEntryId: currentLeafId ?? "entry-0",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 0,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
          settings: DEFAULT_COMPACTION_SETTINGS,
        },
        signal: new AbortController().signal,
      };

      await expect(getHandler("session_before_compact")(event, mockCtx)).resolves.toBeUndefined();
    });

    it("does not wake the orchestrator when fallback branch summary creation throws", async () => {
      await runBoomerang("tool on");
      await fireSessionSwitch();

      const branchWithSummary = (mockCtx.sessionManager as any).branchWithSummary as ReturnType<typeof vi.fn>;
      branchWithSummary.mockImplementationOnce(() => {
        throw new Error("branch summary failed");
      });

      const tool = getTool("boomerang");
      await tool.execute("id-1", {}, undefined, undefined, mockCtx);
      addAssistantTextEntry("tool work");
      await tool.execute("id-2", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();

      expect(uiMock.notify).toHaveBeenCalledWith("Failed to summarize: Error: branch summary failed", "error");
      expect(sentCustomMessages).toEqual([]);
    });

    it("agent can queue a plain task via the tool", async () => {
      await runBoomerang("tool on");

      const tool = getTool("boomerang");
      const result = await tool.execute("id", { task: "fix all the bugs" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("Task queued");

      await triggerAgentEnd();

      expect(sentMessages).toEqual(["fix all the bugs"]);
      expect(navigateTreeCalls).toHaveLength(0);

      addAssistantTextEntry("Fixed them.");
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(1);
    });

    it("tool-queued template tasks restore to the runtime model, not a stale stored command context model", async () => {
      writePrompt("user", "commit", "---\nmodel: claude-opus-4-6\n---\nCommit $@");
      const staleCtx = createCommandCtx({
        model: model("anthropic", "snapshot-model"),
      });

      await runBoomerang("tool on", staleCtx);
      currentModel = model("anthropic", "runtime-model");

      const tool = getTool("boomerang");
      await tool.execute("id", { task: "/commit fix auth" }, undefined, undefined, mockCtx);

      await triggerAgentEnd();
      addAssistantTextEntry("Done.");
      await triggerAgentEnd();

      expect(currentModel).toEqual(model("anthropic", "runtime-model"));
      expect(setModelCalls).toEqual([
        "anthropic/claude-opus-4-6",
        "anthropic/runtime-model",
      ]);
    });

    it("agent can queue a rethrow task via the tool", async () => {
      writePrompt("user", "task", "Task content");
      await runBoomerang("tool on");

      const tool = getTool("boomerang");
      const result = await tool.execute("id", { task: "/task --rethrow 2" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("Task queued");

      await triggerAgentEnd();

      expect(sentMessages).toEqual(["Task content", "Task content"]);
      expect(uiMock.notify).toHaveBeenCalledWith("Rethrow started: 2 iterations", "info");
      expect(uiMock.notify).toHaveBeenCalledWith("Rethrow complete: 2/2", "info");
    });

    it("agent can queue a chain rethrow task via the tool", async () => {
      writePrompt("user", "scout", "Scout: $@");
      writePrompt("user", "impl", "Impl: $@");
      await runBoomerang("tool on");

      const tool = getTool("boomerang");
      const result = await tool.execute("id", { task: '/scout -> /impl --rethrow 2 -- "task"' }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("Task queued");

      await triggerAgentEnd();

      expect(sentMessages).toEqual([
        "Scout: task",
        "Impl: task",
        "Scout: task",
        "Impl: task",
      ]);
      expect(navigateTreeCalls).toHaveLength(2);
    });

    it("agent can queue --loop alias via the tool and surfaces mapping notice", async () => {
      writePrompt("user", "task", "Task $@");
      await runBoomerang("tool on");

      const tool = getTool("boomerang");
      const result = await tool.execute("id", { task: "/task fix auth --loop 2" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("Task queued");

      await triggerAgentEnd();

      expect(sentMessages).toEqual(["Task fix auth", "Task fix auth"]);
      expect(uiMock.notify).toHaveBeenCalledWith("Mapped --loop to boomerang --rethrow 2.", "info");
    });

    it("tool rejects task when boomerang is already active", async () => {
      await runBoomerang("tool on");
      await runBoomerang("some active task");

      const tool = getTool("boomerang");
      const result = await tool.execute("id", { task: "another task" }, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("already active");
    });

    it("boomerang-cancel clears a queued tool task", async () => {
      await runBoomerang("tool on");

      const tool = getTool("boomerang");
      await tool.execute("id", { task: "queued task" }, undefined, undefined, mockCtx);
      await runCancel();

      await triggerAgentEnd();

      expect(sentMessages).toHaveLength(0);
    });

    it("does not allow overriding an already queued tool task", async () => {
      await runBoomerang("tool on");

      const tool = getTool("boomerang");
      const first = await tool.execute("id-1", { task: "first queued task" }, undefined, undefined, mockCtx);
      const second = await tool.execute("id-2", { task: "second queued task" }, undefined, undefined, mockCtx);

      expect(first.content[0].text).toContain("Task queued");
      expect(second.content[0].text).toContain("already queued");
      expect(second.isError).toBe(true);

      await triggerAgentEnd();
      expect(sentMessages).toEqual(["first queued task"]);
    });
  });

  describe("tool enable and disable", () => {
    it("does not register the tool when disabled by default", async () => {
      expect(getTool("boomerang")).toBeUndefined();
    });

    it("enables the tool with /boomerang tool on", async () => {
      await runBoomerang("tool on");
      const result = await getTool("boomerang").execute("id", {}, undefined, undefined, mockCtx);

      expect(uiMock.notify).toHaveBeenCalledWith(
        "Boomerang tool enabled. Agent can now use boomerang().",
        "info"
      );
      expect(result.content[0].text).toContain("anchor set");
    });

    it("disables the tool with /boomerang tool off", async () => {
      await runBoomerang("tool on");
      await runBoomerang("tool off");
      const result = await getTool("boomerang").execute("id", {}, undefined, undefined, mockCtx);

      expect(uiMock.notify).toHaveBeenCalledWith("Boomerang tool disabled.", "info");
      expect(result.content[0].text).toContain("Boomerang tool is disabled");
    });

    it("shows the current tool status with /boomerang tool", async () => {
      await runBoomerang("tool on");
      await runBoomerang("tool");

      expect(uiMock.notify).toHaveBeenLastCalledWith("Boomerang tool is enabled", "info");
    });

    it("preserves tool state across session switches", async () => {
      await runBoomerang("tool on");
      await fireSessionSwitch();
      const result = await getTool("boomerang").execute("id", {}, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("anchor set");
    });

    it("accepts inline guidance with tool on", async () => {
      await runBoomerang('tool on Use only for refactoring tasks');

      expect(uiMock.notify).toHaveBeenCalledWith(
        'Boomerang tool enabled with guidance: "Use only for refactoring tasks"',
        "info"
      );
    });

    it("strips quotes from inline guidance", async () => {
      await runBoomerang('tool on "Use for multi-file changes"');

      expect(uiMock.notify).toHaveBeenCalledWith(
        'Boomerang tool enabled with guidance: "Use for multi-file changes"',
        "info"
      );
    });

    it("keeps existing guidance when re-enabling without new guidance", async () => {
      await runBoomerang('tool on Original guidance');
      await runBoomerang('tool off');
      await runBoomerang('tool on');
      await runBoomerang('tool');

      expect(uiMock.notify).toHaveBeenLastCalledWith(
        'Boomerang tool is enabled | Guidance: "Original guidance"',
        "info"
      );
    });
  });

  describe("guidance subcommand", () => {
    it("sets guidance with /boomerang guidance", async () => {
      await runBoomerang('guidance Use for complex refactoring');

      expect(uiMock.notify).toHaveBeenCalledWith(
        'Guidance set: "Use for complex refactoring"',
        "info"
      );
    });

    it("shows current guidance with /boomerang guidance show", async () => {
      await runBoomerang('guidance Some guidance text');
      await runBoomerang('guidance show');

      expect(uiMock.notify).toHaveBeenLastCalledWith(
        'Current guidance: "Some guidance text"',
        "info"
      );
    });

    it("shows no guidance message when none set", async () => {
      await runBoomerang('guidance');

      expect(uiMock.notify).toHaveBeenCalledWith(
        "No guidance set. Use `/boomerang guidance <text>` to set.",
        "info"
      );
    });

    it("clears guidance with /boomerang guidance clear", async () => {
      await runBoomerang('guidance Some guidance');
      await runBoomerang('guidance clear');

      expect(uiMock.notify).toHaveBeenLastCalledWith("Guidance cleared.", "info");
    });

    it("injects guidance into system prompt when tool is enabled", async () => {
      await runBoomerang('tool on');
      await runBoomerang('guidance Use for tasks that modify 3+ files');

      const result = await fireBeforeAgentStart("original prompt");

      expect(result?.systemPrompt).toContain("Use for tasks that modify 3+ files");
    });

    it("uses default guidance when tool enabled without custom guidance", async () => {
      await runBoomerang('tool on');

      const result = await fireBeforeAgentStart("original prompt");

      expect(result?.systemPrompt).toContain("boomerang tool is available");
      expect(result?.systemPrompt).toContain("large, multi-step tasks");
    });

    it("does not inject guidance when tool is disabled", async () => {
      await runBoomerang('guidance Some guidance');

      const result = await fireBeforeAgentStart("original prompt");

      expect(result).toBeUndefined();
    });
  });

  describe("config persistence", () => {
    it("persists tool enabled state to config file", async () => {
      await runBoomerang('tool on');

      const { path } = getConfigPath();
      const config = JSON.parse(readFileSync(path, "utf-8"));
      expect(config.toolEnabled).toBe(true);
    });

    it("surfaces config save failures instead of swallowing them", async () => {
      writeFile(join(homeDir, ".pi"), "not-a-directory");

      await runBoomerang('guidance should-warn');

      expect(notifyMessages().some(({ message, level }) =>
        level === "warning" && message.startsWith("Failed to save boomerang config:")
      )).toBe(true);
    });

    it("persists guidance to config file", async () => {
      await runBoomerang('guidance My custom guidance');

      const { path } = getConfigPath();
      const config = JSON.parse(readFileSync(path, "utf-8"));
      expect(config.toolGuidance).toBe("My custom guidance");
    });

    it("loads config on extension init", async () => {
      const { dir, path } = getConfigPath();
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify({ toolEnabled: true, toolGuidance: "Persisted guidance" }));

      boomerangExtension(mockPi);

      const result = await getTool("boomerang").execute("id", {}, undefined, undefined, mockCtx);
      expect(result.content[0].text).toContain("anchor set");
    });
  });

});
