/**
 * pi-boomerang - Token-efficient autonomous task execution
 *
 * Executes a task autonomously, then collapses the entire exchange into
 * a brief summary using navigateTree (like /tree does).
 *
 * Usage: /boomerang <task>
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, SessionEntry, SessionManager } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

const BOOMERANG_INSTRUCTIONS = `BOOMERANG MODE ACTIVE

You are in boomerang mode - a token-efficient execution mode where:
1. You complete the task fully and autonomously (no clarifying questions)
2. When done, this entire exchange is collapsed into a brief summary
3. Future context will only show what was accomplished, not the step-by-step details

Make reasonable assumptions. Work thoroughly - there is no back-and-forth.
When finished, briefly state what you did.`;

export default function (pi: ExtensionAPI) {
  let boomerangActive = false;
  let boomerangStartEntryId = "";

  let anchorEntryId: string | null = null;
  let anchorSummaries: string[] = [];

  let pendingCollapse: {
    targetId: string;
    task: string;
    commandCtx: ExtensionCommandContext;
  } | null = null;

  let lastTaskSummary: string | null = null;

  let toolAnchorEntryId: string | null = null;
  let toolCollapsePending = false;
  let storedCommandCtx: ExtensionCommandContext | null = null;

  function clearState() {
    boomerangActive = false;
    boomerangStartEntryId = "";
    anchorEntryId = null;
    anchorSummaries = [];
    pendingCollapse = null;
    lastTaskSummary = null;
    toolAnchorEntryId = null;
    toolCollapsePending = false;
    storedCommandCtx = null;
  }

  function clearTaskState() {
    boomerangActive = false;
    boomerangStartEntryId = "";
    pendingCollapse = null;
    lastTaskSummary = null;
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (boomerangActive) {
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("warning", "boomerang"));
    } else if (anchorEntryId !== null) {
      ctx.ui.setStatus("boomerang", ctx.ui.theme.fg("cyan", "anchor"));
    } else {
      ctx.ui.setStatus("boomerang", undefined);
    }
  }

  function generateSummaryFromEntries(entries: SessionEntry[], task: string): string {
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    let commandCount = 0;

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "assistant") continue;

      for (const block of (msg as AssistantMessage).content) {
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

    const parts: string[] = [];
    if (filesRead.size > 0) parts.push(`read ${filesRead.size} file(s)`);
    if (filesWritten.size > 0) parts.push(`modified ${[...filesWritten].join(", ")}`);
    if (commandCount > 0) parts.push(`ran ${commandCount} command(s)`);
    const result = parts.length > 0 ? parts.join(", ") : "no file operations recorded";

    return `[BOOMERANG COMPLETE]\nTask: "${task}"\nResult: ${result.charAt(0).toUpperCase() + result.slice(1)}.`;
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

      const task = trimmed;
      if (!task) {
        ctx.ui.notify("Usage: /boomerang <task> | anchor [clear|show]", "error");
        return;
      }
      if (boomerangActive) {
        ctx.ui.notify("Boomerang already active. Use /boomerang-cancel to abort.", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait for completion first.", "error");
        return;
      }

      const startEntryId = ctx.sessionManager.getLeafId();
      if (!startEntryId && !anchorEntryId) {
        ctx.ui.notify("No session entry to start from", "error");
        return;
      }

      clearTaskState();
      boomerangActive = true;
      boomerangStartEntryId = startEntryId ?? "";

      const targetId = anchorEntryId ?? boomerangStartEntryId;
      pendingCollapse = { targetId, task, commandCtx: ctx };

      updateStatus(ctx);
      ctx.ui.notify("Boomerang started. Agent will work autonomously.", "info");

      pi.sendUserMessage(task);
    },
  });

  pi.registerCommand("boomerang-cancel", {
    description: "Cancel active boomerang (no context collapse)",
    handler: async (_args, ctx) => {
      storedCommandCtx = ctx;
      if (!boomerangActive && toolAnchorEntryId === null && !toolCollapsePending) {
        ctx.ui.notify("No boomerang active", "warning");
        return;
      }
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

  pi.on("before_agent_start", async (event) => {
    if (!boomerangActive) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + BOOMERANG_INSTRUCTIONS,
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Handle tool-initiated collapse
    if (toolCollapsePending && toolAnchorEntryId) {
      toolCollapsePending = false;

      if (!storedCommandCtx) {
        // Fallback: branchWithSummary then trigger new turn to pick up collapsed context
        const sm = ctx.sessionManager as SessionManager;
        const branch = sm.getBranch();
        const startIndex = branch.findIndex((e) => e.id === toolAnchorEntryId);
        const workEntries = startIndex >= 0 ? branch.slice(startIndex + 1) : [];
        const summary = generateSummaryFromEntries(workEntries, "Agent-initiated task");
        try {
          await sm.branchWithSummary(toolAnchorEntryId, summary);
          // Tree is collapsed - agent will see collapsed context on next turn
          // TUI display doesn't update until /reload or session restart
          ctx.ui.notify("Context collapsed (agent sees it; /reload to refresh display)", "info");
        } catch (err) {
          ctx.ui.notify(`Failed to collapse: ${err}`, "error");
        }
        toolAnchorEntryId = null;
        return;
      }

      // Use navigateTree for immediate UI update
      const targetId = toolAnchorEntryId;
      toolAnchorEntryId = null;
      pendingCollapse = { targetId, task: "Agent-initiated task", commandCtx: storedCommandCtx };

      try {
        const result = await storedCommandCtx.navigateTree(targetId, { summarize: true });
        if (result.cancelled) {
          ctx.ui.notify("Collapse cancelled", "warning");
        } else {
          ctx.ui.notify("Boomerang complete. Context collapsed.", "info");
        }
      } catch (err) {
        ctx.ui.notify(`Failed to collapse: ${err}`, "error");
      }
      pendingCollapse = null;
      return;
    }

    if (!boomerangActive || !pendingCollapse) return;

    const { targetId, task, commandCtx } = pendingCollapse;

    try {
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
    }

    clearTaskState();
    updateStatus(ctx);
  });

  pi.on("session_before_tree", async (event, _ctx) => {
    if (!pendingCollapse) return;

    const entries = event.preparation.entriesToSummarize;
    const summary = generateSummaryFromEntries(entries, pendingCollapse.task);

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

  pi.on("session_start", async (_event, ctx) => {
    clearState();
    updateStatus(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    clearState();
    updateStatus(ctx);
  });
}
