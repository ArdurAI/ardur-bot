import {
  resolveActionApproval,
  toolRequiresApproval,
  unattendedTriggerToolRequiresApproval,
} from "@ardurbot/core";
import { expect, it, vi } from "vitest";
import { builtinAgentTools } from "../builtin-tools.js";
import type { BoardService } from "./service.js";
import { boardToolSchemas, boardTools, executeBoardTool } from "./tools.js";

it("registers all eight tools with the shared runtime registry and honors approval rules", () => {
  expect(boardTools).toHaveLength(8);
  for (const tool of boardTools) {
    expect(builtinAgentTools.some((entry) => entry.name === tool.name)).toBe(true);
    expect(toolRequiresApproval(tool.name, false)).toBe(false);
    expect(
      resolveActionApproval({
        toolName: tool.name,
        botId: "builder",
        rules: [
          {
            effect: "require_approval",
            matchKind: "tool",
            matchValue: tool.name,
            botId: "builder",
          },
        ],
      }),
    ).toBe("ask");
    expect(unattendedTriggerToolRequiresApproval("webhook", tool.name, false)).toBe(
      !["board_ready", "board_show"].includes(tool.name),
    );
  }
  expect(boardTools.some((tool) => tool.name.includes("delete"))).toBe(false);
  expect(
    boardToolSchemas.board_update.parse({ id: "board-a", patch: { closeWhenDone: true } }).patch,
  ).toEqual({});
});
it("dispatches through the scoped provider and derives claim identity from the bot", async () => {
  const provider = {
    ready: vi.fn(async () => []),
    show: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    claim: vi.fn(),
    close: vi.fn(),
    comment: vi.fn(),
    link: vi.fn(),
  };
  const service = {
    provider: vi.fn(async () => provider),
    actor: vi.fn(async () => "bot:Builder"),
    assertBotMayClose: vi.fn(),
  };
  const scope = { userId: "owner", spaceId: "space", botId: "builder", runId: "run" };
  const calls = [
    ["board_ready", {}],
    ["board_show", { id: "board-a" }],
    ["board_create", { item: { title: "Task" } }],
    ["board_update", { id: "board-a", patch: { title: "Changed" } }],
    ["board_claim", { id: "board-a", actor: "forged" }],
    ["board_close", { ids: ["board-a"], reason: "Done" }],
    ["board_comment", { id: "board-a", text: "Progress" }],
    ["board_link", { from: "board-b", to: "board-a", type: "blocks" }],
  ] as const;
  for (const [name, input] of calls)
    await executeBoardTool(service as unknown as BoardService, scope, name, {
      ...input,
      workspaceId: "workspace",
    });
  expect(service.provider).toHaveBeenCalledWith(scope, "workspace");
  expect(provider.claim).toHaveBeenCalledWith("board-a", "bot:Builder");
  expect(provider.link).toHaveBeenCalledWith("board-b", "board-a", "blocks");
  expect(service.assertBotMayClose).toHaveBeenCalledWith(scope, "workspace", ["board-a"]);
});
