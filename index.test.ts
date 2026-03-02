import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import boomerangExtension from "./index.js";

describe("Boomerang Extension", () => {
  let handlers: Map<string, Function[]>;
  let commands: Map<string, { description: string; handler: Function }>;
  let tools: Map<string, any>;
  let sentMessages: string[];
  let sessionEntries: any[];
  let navigateTreeCalls: { targetId: string; options: any }[];
  let branchWithSummaryCalls: { targetId: string; summary: string }[];
  let capturedSummary: any;
  let uiMock: any;
  let currentLeafId: string;

  let mockPi: ExtensionAPI;
  let mockCtx: ExtensionContext;
  let mockCommandCtx: ExtensionCommandContext;

  function getCommand(name: string) {
    return commands.get(name)!.handler;
  }

  function getHandler(name: string) {
    return handlers.get(name)?.[0];
  }

  function getTool(name: string) {
    return tools.get(name);
  }

  async function setAnchor() {
    await getCommand("boomerang")("anchor", mockCommandCtx);
  }

  async function startBoomerang(task = "task") {
    await getCommand("boomerang")(task, mockCommandCtx);
  }

  async function triggerAgentEnd() {
    const handler = getHandler("agent_end");
    if (handler) {
      await handler({}, mockCtx);
    }
  }

  function addSessionEntry(id: string, entry: any) {
    sessionEntries.push({ id, ...entry });
    currentLeafId = id;
  }

  function createCommandCtx(overrides: Partial<ExtensionCommandContext> = {}) {
    return {
      ...mockCtx,
      navigateTree: vi.fn(async (targetId: string, options: any) => {
        navigateTreeCalls.push({ targetId, options });
        const handler = getHandler("session_before_tree");
        if (handler) {
          const result = await handler(
            {
              preparation: {
                targetId,
                oldLeafId: currentLeafId,
                entriesToSummarize: sessionEntries.slice(1),
                userWantsSummary: true,
              },
            },
            mockCtx
          );
          capturedSummary = result;
        }
        return { cancelled: false };
      }),
      ...overrides,
    } as unknown as ExtensionCommandContext;
  }

  beforeEach(() => {
    handlers = new Map();
    commands = new Map();
    tools = new Map();
    sentMessages = [];
    sessionEntries = [];
    navigateTreeCalls = [];
    branchWithSummaryCalls = [];
    capturedSummary = null;
    currentLeafId = "entry-0";

    addSessionEntry("entry-0", {
      type: "message",
      message: { role: "user", content: "hello", timestamp: 1000 },
      timestamp: new Date(1000).toISOString(),
    });

    mockPi = {
      on: vi.fn((event: string, handler: Function) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      }),
      registerCommand: vi.fn((name: string, options: any) => commands.set(name, options)),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      sendUserMessage: vi.fn((content: string) => {
        sentMessages.push(content);
        const id = `entry-${sessionEntries.length}`;
        addSessionEntry(id, {
          type: "message",
          message: { role: "user", content, timestamp: Date.now() },
          timestamp: new Date().toISOString(),
        });
      }),
    } as unknown as ExtensionAPI;

    uiMock = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (color: string, text: string) => `[${color}]${text}` },
    };

    mockCtx = {
      hasUI: true,
      ui: uiMock,
      isIdle: vi.fn(() => true),
      sessionManager: {
        getBranch: () => sessionEntries,
        getLeafId: () => currentLeafId,
        branchWithSummary: vi.fn(async (targetId: string, summary: string) => {
          branchWithSummaryCalls.push({ targetId, summary });
        }),
      },
    } as unknown as ExtensionContext;

    mockCommandCtx = createCommandCtx();

    boomerangExtension(mockPi);
  });

  describe("/boomerang command", () => {
    it("rejects empty task", async () => {
      await getCommand("boomerang")("", mockCommandCtx);
      expect(uiMock.notify).toHaveBeenCalledWith(
        "Usage: /boomerang <task> | anchor [clear|show]",
        "error"
      );
    });

    it("rejects when already active", async () => {
      await startBoomerang("task 1");
      await getCommand("boomerang")("task 2", mockCommandCtx);

      expect(uiMock.notify).toHaveBeenLastCalledWith(
        "Boomerang already active. Use /boomerang-cancel to abort.",
        "error"
      );
    });

    it("rejects when agent is busy", async () => {
      vi.mocked(mockCtx.isIdle).mockReturnValue(false);
      await getCommand("boomerang")("task", mockCommandCtx);
      expect(uiMock.notify).toHaveBeenLastCalledWith("Agent is busy. Wait for completion first.", "error");
    });

    it("sends task and sets status", async () => {
      await startBoomerang("fix the bug");
      expect(sentMessages).toContain("fix the bug");
      expect(uiMock.setStatus).toHaveBeenCalledWith("boomerang", "[warning]boomerang");
    });

    it("calls navigateTree in agent_end", async () => {
      await startBoomerang("task");
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(1);
      expect(navigateTreeCalls[0].options.summarize).toBe(true);
    });

    it("uses correct targetId for navigateTree", async () => {
      const initialLeafId = currentLeafId;
      await startBoomerang("task");
      await triggerAgentEnd();

      expect(navigateTreeCalls[0].targetId).toBe(initialLeafId);
    });

    it("clears status and notifies on success", async () => {
      await startBoomerang("task");
      await triggerAgentEnd();

      expect(uiMock.notify).toHaveBeenLastCalledWith("Boomerang complete. Context collapsed.", "info");
      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
    });
  });

  describe("anchor commands", () => {
    it("sets anchor", async () => {
      await setAnchor();
      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", "[cyan]anchor");
      expect(uiMock.notify).toHaveBeenLastCalledWith(
        "Anchor set. Subsequent boomerangs will collapse to this point.",
        "info"
      );
    });

    it("clears anchor", async () => {
      await setAnchor();
      await getCommand("boomerang")("anchor clear", mockCommandCtx);
      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
      expect(uiMock.notify).toHaveBeenLastCalledWith("Anchor cleared", "info");
    });

    it("shows anchor status", async () => {
      await setAnchor();
      await getCommand("boomerang")("anchor show", mockCommandCtx);
      expect(uiMock.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("Anchor at entry"),
        "info"
      );
    });

    it("blocks anchor while boomerang is active", async () => {
      await startBoomerang("task");
      await getCommand("boomerang")("anchor", mockCommandCtx);

      expect(uiMock.notify).toHaveBeenLastCalledWith(
        "Cannot set anchor while boomerang is active",
        "error"
      );
    });

    it("uses anchor entry ID for navigateTree target", async () => {
      const anchorLeafId = currentLeafId;
      await setAnchor();
      addSessionEntry("entry-intervene", {
        type: "message",
        message: { role: "user", content: "intervening" },
      });
      await startBoomerang("task");
      await triggerAgentEnd();

      expect(navigateTreeCalls[0].targetId).toBe(anchorLeafId);
    });

    it("warns when clearing anchor that does not exist", async () => {
      await getCommand("boomerang")("anchor clear", mockCommandCtx);
      expect(uiMock.notify).toHaveBeenCalledWith("No anchor set", "warning");
    });

    it("shows correct task count in anchor show", async () => {
      await setAnchor();
      await startBoomerang("task 1");
      await triggerAgentEnd();
      await startBoomerang("task 2");
      await triggerAgentEnd();
      await getCommand("boomerang")("anchor show", mockCommandCtx);

      expect(uiMock.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("2 task(s) completed"),
        "info"
      );
    });
  });

  describe("/boomerang-cancel", () => {
    it("cancels active boomerang", async () => {
      await startBoomerang("task");
      await getCommand("boomerang-cancel")("", mockCommandCtx);

      expect(uiMock.notify).toHaveBeenLastCalledWith("Boomerang cancelled", "info");
      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
    });

    it("preserves anchor when cancelling", async () => {
      await setAnchor();
      await startBoomerang("task");
      await getCommand("boomerang-cancel")("", mockCommandCtx);

      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", "[cyan]anchor");
    });

    it("warns when no boomerang active", async () => {
      await getCommand("boomerang-cancel")("", mockCommandCtx);
      expect(uiMock.notify).toHaveBeenLastCalledWith("No boomerang active", "warning");
    });
  });

  describe("before_agent_start hook", () => {
    it("injects boomerang instructions when active", async () => {
      await startBoomerang("task");

      const result = await getHandler("before_agent_start")(
        { systemPrompt: "original" },
        mockCtx
      );
      expect(result.systemPrompt).toContain("BOOMERANG MODE ACTIVE");
      expect(result.systemPrompt).toContain("original");
    });

    it("does nothing when not active", async () => {
      const result = await getHandler("before_agent_start")(
        { systemPrompt: "original" },
        mockCtx
      );
      expect(result).toBeUndefined();
    });
  });

  describe("session_before_tree hook", () => {
    it("provides custom summary when boomerang collapse is pending", async () => {
      addSessionEntry("work-1", {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "edit", arguments: { path: "src/auth.ts" } }],
        },
      });

      await getCommand("boomerang")("fix the bug", mockCommandCtx);
      await triggerAgentEnd();

      expect(capturedSummary).toBeDefined();
      expect(capturedSummary.summary.summary).toContain("BOOMERANG COMPLETE");
      expect(capturedSummary.summary.summary).toContain("fix the bug");
      expect(capturedSummary.summary.summary).toContain("Modified src/auth.ts");
    });

    it("does nothing when no boomerang pending", async () => {
      const handler = getHandler("session_before_tree");
      const result = await handler(
        { preparation: { entriesToSummarize: [] } },
        mockCtx
      );
      expect(result).toBeUndefined();
    });

    it("accumulates summaries in anchor mode", async () => {
      await setAnchor();

      addSessionEntry("work-1", {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "edit", arguments: { path: "file1.ts" } }],
        },
      });
      await startBoomerang("task 1");
      await triggerAgentEnd();

      addSessionEntry("work-2", {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "edit", arguments: { path: "file2.ts" } }],
        },
      });
      await startBoomerang("task 2");
      await triggerAgentEnd();

      expect(capturedSummary.summary.summary).toContain("task 1");
      expect(capturedSummary.summary.summary).toContain("task 2");
    });
  });

  describe("navigateTree error handling", () => {
    it("notifies and cleans up when navigateTree fails", async () => {
      const failCtx = createCommandCtx({
        navigateTree: vi.fn(async () => {
          throw new Error("navigation failed");
        }),
      });

      await getCommand("boomerang")("task", failCtx);
      await triggerAgentEnd();

      expect(uiMock.notify).toHaveBeenCalledWith(
        expect.stringContaining("Failed to collapse"),
        "error"
      );
      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
    });

    it("handles cancelled navigation", async () => {
      const cancelCtx = createCommandCtx({
        navigateTree: vi.fn(async () => ({ cancelled: true })),
      });

      await getCommand("boomerang")("task", cancelCtx);
      await triggerAgentEnd();

      expect(uiMock.notify).toHaveBeenLastCalledWith("Collapse cancelled", "warning");
    });

    it("does not persist anchor summary when navigateTree fails", async () => {
      await setAnchor();

      const failCtx = createCommandCtx({
        navigateTree: vi.fn(async () => {
          throw new Error("fail");
        }),
      });

      await getCommand("boomerang")("task 1", failCtx);
      await triggerAgentEnd();

      addSessionEntry("work-2", {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "edit", arguments: { path: "file2.ts" } }],
        },
      });
      await startBoomerang("task 2");
      await triggerAgentEnd();

      expect(capturedSummary.summary.summary).toContain("task 2");
      expect(capturedSummary.summary.summary).not.toContain("task 1");
    });
  });

  describe("boomerang tool", () => {
    it("sets anchor on first call", async () => {
      const tool = getTool("boomerang");
      const result = await tool.execute("id", {}, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("anchor set");
    });

    it("returns error if no session entries", async () => {
      sessionEntries.length = 0;
      currentLeafId = "";
      const noLeafCtx = {
        ...mockCtx,
        sessionManager: {
          ...mockCtx.sessionManager,
          getLeafId: () => null,
        },
      };

      const tool = getTool("boomerang");
      const result = await tool.execute("id", {}, undefined, undefined, noLeafCtx);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no session entries");
    });

    it("queues collapse on second call", async () => {
      const tool = getTool("boomerang");
      await tool.execute("id", {}, undefined, undefined, mockCtx);
      const result = await tool.execute("id", {}, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("Context will collapse");
    });

    it("uses branchWithSummary when no command context stored", async () => {
      const tool = getTool("boomerang");
      await tool.execute("id", {}, undefined, undefined, mockCtx);
      await tool.execute("id", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();

      expect(branchWithSummaryCalls).toHaveLength(1);
      expect(uiMock.notify).toHaveBeenCalledWith(
        expect.stringContaining("Context collapsed"),
        "info"
      );
    });

    it("uses navigateTree when command context is stored", async () => {
      // First run a command to store context
      await setAnchor();

      const tool = getTool("boomerang");
      await tool.execute("id", {}, undefined, undefined, mockCtx);
      await tool.execute("id", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();

      expect(navigateTreeCalls).toHaveLength(1);
      expect(branchWithSummaryCalls).toHaveLength(0);
    });

    it("is disabled during active command boomerang", async () => {
      await startBoomerang("task");

      const tool = getTool("boomerang");
      const result = await tool.execute("id", {}, undefined, undefined, mockCtx);

      expect(result.content[0].text).toContain("Command boomerang is active");
    });

    it("does not include command anchor summaries in tool collapse", async () => {
      // Set command anchor and do a command boomerang
      await setAnchor();
      await startBoomerang("command task");
      await triggerAgentEnd();

      // Now use the tool - should NOT include command anchor summaries
      const tool = getTool("boomerang");
      await tool.execute("id", {}, undefined, undefined, mockCtx);
      await tool.execute("id", {}, undefined, undefined, mockCtx);
      await triggerAgentEnd();

      // The last summary should only contain the tool task, not the command task
      expect(capturedSummary.summary.summary).toContain("Agent-initiated task");
      expect(capturedSummary.summary.summary).not.toContain("command task");
    });
  });

  describe("summary extraction", () => {
    async function getSummaryForEntries(entries: any[]) {
      for (const entry of entries) {
        sessionEntries.push(entry);
      }

      await startBoomerang("task");
      await triggerAgentEnd();
      return capturedSummary?.summary?.summary;
    }

    it("extracts file operations from tool calls", async () => {
      const entries = [
        {
          id: "e1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "read", arguments: { path: "file1.ts" } }],
          },
        },
        {
          id: "e2",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "edit", arguments: { path: "file2.ts" } }],
          },
        },
        {
          id: "e3",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
          },
        },
      ];

      const summary = await getSummaryForEntries(entries);
      expect(summary).toContain("Read 1 file(s)");
      expect(summary).toContain("modified file2.ts");
      expect(summary).toContain("ran 1 command(s)");
    });

    it("extracts write tool calls", async () => {
      const entries = [
        {
          id: "e1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "write", arguments: { path: "new-file.ts" } }],
          },
        },
      ];

      const summary = await getSummaryForEntries(entries);
      expect(summary).toContain("Modified new-file.ts");
    });

    it("deduplicates repeated file operations", async () => {
      const entries = [
        {
          id: "e1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "read", arguments: { path: "same.ts" } }],
          },
        },
        {
          id: "e2",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "read", arguments: { path: "same.ts" } }],
          },
        },
      ];

      const summary = await getSummaryForEntries(entries);
      expect(summary).toContain("Read 1 file(s)");
    });

    it("reports no file operations when agent uses no tools", async () => {
      const entries = [
        {
          id: "e1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        },
      ];

      const summary = await getSummaryForEntries(entries);
      expect(summary).toContain("No file operations recorded");
    });

    it("extracts multiple tool calls from single message", async () => {
      const entries = [
        {
          id: "e1",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", name: "read", arguments: { path: "file1.ts" } },
              { type: "toolCall", name: "edit", arguments: { path: "file2.ts" } },
              { type: "toolCall", name: "bash", arguments: { command: "npm test" } },
            ],
          },
        },
      ];

      const summary = await getSummaryForEntries(entries);
      expect(summary).toContain("Read 1 file(s)");
      expect(summary).toContain("modified file2.ts");
      expect(summary).toContain("ran 1 command(s)");
    });

    it("capitalizes the first word of the result", async () => {
      const entries = [
        {
          id: "e1",
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "read", arguments: { path: "file.ts" } }],
          },
        },
      ];

      const summary = await getSummaryForEntries(entries);
      expect(summary).toMatch(/Result: Read/);
    });
  });

  describe("session lifecycle", () => {
    it.each(["session_start", "session_switch"])("clears state on %s", async (event) => {
      await setAnchor();
      await startBoomerang("task");
      await getHandler(event)({}, mockCtx);

      expect(uiMock.setStatus).toHaveBeenLastCalledWith("boomerang", undefined);
    });
  });
});
