import type { WorkItem } from "@ardurbot/contracts/board";
import { expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "../executor.js";
import { agentToolsForRequest } from "../pi-runtime.js";
import { advertisedHostTools } from "../remote-host-runtime.js";
import { createArdurToolBridge } from "../runtimes/claude-mcp-bridge.js";
import { parseBeadsItem } from "./beads.js";
import { BoardService } from "./service.js";
import { executeBoardTool } from "./tools.js";
import {
  applyBoardToolAccess,
  BOARD_UPKEEP_SECTION,
  botUpkeepPrompt,
  MEMORY_UPKEEP_SENTENCE,
  measureInstructionTokens,
} from "./upkeep.js";

const baseTools = {
  graphicalToolsAllowed: false,
  pageBrowserAllowed: false,
  groupId: null,
  trigger: "message",
  semanticMemoryEnabled: false,
  messagingChannelRun: false,
} as const;

function names(board: "write" | "read" | "none", enabled = true) {
  return applyBoardToolAccess(selectBuiltinToolsForRun(baseTools), { enabled, board }).map(
    (tool) => tool.name,
  );
}

const item = (title: string, status = "open"): WorkItem =>
  ({
    id: "board-a",
    title,
    description: "",
    acceptanceCriteria: "",
    type: "task",
    status,
    priority: 2,
    assignee: null,
    labels: [],
    parent: null,
    dependencies: [],
    dueAt: null,
    deferUntil: null,
    estimateMinutes: null,
    externalRef: null,
    createdAt: "",
    updatedAt: "",
    closedAt: status === "closed" ? "2026-09-25T00:00:00.000Z" : null,
    commentCount: 0,
    comments: [],
    history: [],
    closeWhenDone: false,
    filedBy: null,
  }) as WorkItem;

function service(options?: { open?: WorkItem[]; filings?: number; hourFilings?: number }) {
  const filings = Array.from({ length: options?.filings ?? 0 }, (_, index) => ({
    id: `run-${index}`,
    spaceId: "space",
    runId: "run",
    createdAt: new Date(),
  }));
  for (let index = 0; index < (options?.hourFilings ?? 0); index += 1) {
    filings.push({
      id: `hour-${index}`,
      spaceId: "space",
      runId: `other-${index}`,
      createdAt: new Date(),
    });
  }
  const prisma = {
    botBoardFiling: {
      count: vi.fn(
        async ({ where }: { where: { runId?: string; spaceId: string; createdAt?: unknown } }) =>
          filings.filter((row) => (where.runId ? row.runId === where.runId : true)).length,
      ),
      create: vi.fn(async ({ data }: { data: { spaceId: string; runId: string } }) => {
        const row = { id: `new-${filings.length}`, createdAt: new Date(), ...data };
        filings.push(row);
        return row;
      }),
      delete: vi.fn(async () => ({})),
    },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const created = item("Task");
  const provider = {
    list: vi.fn(async () => options?.open ?? []),
    create: vi.fn(async () => created),
    update: vi.fn(async () => created),
    comment: vi.fn(async () => ({ id: "c", author: "bot:Builder", text: "", createdAt: "" })),
    close: vi.fn(async () => [created]),
    noteFiling: vi.fn(async () => ({
      ...created,
      labels: ["bot-filed"],
      filedBy: { botId: "builder", botName: "Builder", runId: "run" },
    })),
    show: vi.fn(),
    ready: vi.fn(),
    claim: vi.fn(),
    link: vi.fn(),
  };
  const board = new BoardService({ prisma: prisma as never, dataDir: "/fixture" });
  vi.spyOn(board, "provider").mockResolvedValue(provider as never);
  vi.spyOn(board, "actor").mockResolvedValue("bot:Builder");
  return { board, provider, prisma };
}

const scope = { userId: "owner", spaceId: "space", botId: "builder", runId: "run" };

it("keeps the board section under 150 tokens and states the working style", () => {
  const tokens = measureInstructionTokens(BOARD_UPKEEP_SECTION);
  expect(tokens).toBe(97);
  expect(tokens).toBeLessThanOrEqual(150);
  expect(BOARD_UPKEEP_SECTION).toContain("acceptance criteria");
  expect(BOARD_UPKEEP_SECTION).toContain(MEMORY_UPKEEP_SENTENCE);
  expect(BOARD_UPKEEP_SECTION).toContain("remember");
  expect(botUpkeepPrompt({ enabled: true, board: "write", reason: null, memory: true })).toBe(
    BOARD_UPKEEP_SECTION,
  );
  expect(botUpkeepPrompt({ enabled: false, board: "write", reason: null, memory: true })).toBe("");
  expect(botUpkeepPrompt({ enabled: true, board: "none", reason: "no-board", memory: true })).toBe(
    `This space has no board this bot can use. ${MEMORY_UPKEEP_SENTENCE}`,
  );
  expect(
    botUpkeepPrompt({ enabled: true, board: "none", reason: "unreachable", memory: false }),
  ).toBe("This bot cannot reach the board's computer.");
  expect(
    botUpkeepPrompt({ enabled: true, board: "read", reason: "read-only", memory: true }),
  ).toContain("This board is read-only for this run.");
});

it.each(["pi", "claude-code", "codex-app-server", "scripted"] as const)(
  "advertises board tools on %s only when the bot can write",
  (runtime) => {
    const writable = names("write");
    const hidden = names("none");
    const reading = names("read");
    const today = names("none", false);
    expect(writable).toEqual(expect.arrayContaining(["board_create", "board_ready", "remember"]));
    expect(hidden).not.toEqual(expect.arrayContaining(["board_create", "board_ready"]));
    expect(reading).toContain("board_show");
    expect(reading).not.toContain("board_create");
    expect(today).toContain("board_create");
    const deliver = (selected: string[]) => {
      const tools = selected.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
      }));
      if (runtime === "pi" || runtime === "scripted")
        return agentToolsForRequest(tools).map((tool) => tool.name);
      return createArdurToolBridge(
        {
          botId: "bot",
          threadId: "thread",
          runId: "run",
          prompt: "",
          instructions: "",
          history: [],
          model: { provider: "anthropic", id: "model" },
          tools,
        },
        () => undefined,
        () => undefined,
      ).tools.map((tool) => tool.name);
    };
    expect(deliver(writable)).toEqual(expect.arrayContaining(["board_create", "board_comment"]));
    expect(deliver(hidden)).not.toContain("board_create");
    if (runtime === "claude-code") {
      const hosted = advertisedHostTools(
        writable.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
      );
      expect(hosted).not.toBe("none");
      if (hosted !== "none") expect(hosted.map((tool) => tool.name)).toContain("board_create");
    }
  },
);

it("returns the open item when a normalized title already exists", async () => {
  const { board, provider } = service({ open: [item("  Ship  The   Board  ")] });
  const result = await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "ship the board" } },
    { upkeep: true },
  );
  expect(result).toMatchObject({
    duplicate: true,
    item: { id: "board-a" },
    message: "An open item already has this title: board-a.",
  });
  expect(provider.create).not.toHaveBeenCalled();
});

it("stops a run at 5 filings and a space at 30 filings an hour", async () => {
  const capped = service({ filings: 5 });
  const runLimited = await executeBoardTool(
    capped.board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Another" } },
    { upkeep: true },
  );
  expect(runLimited).toEqual({
    error:
      "This run already filed 5 board items. Comment on an existing item instead of creating another.",
  });
  expect(capped.provider.create).not.toHaveBeenCalled();
  const busy = service({ hourFilings: 30 });
  const spaceLimited = await executeBoardTool(
    busy.board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Another" } },
    { upkeep: true },
  );
  expect(spaceLimited).toEqual({
    error: "This space already filed 30 board items this hour. Try again later.",
  });
  expect(busy.provider.create).not.toHaveBeenCalled();
});

it("redacts run secrets from titles, bodies and comments and marks bot filings", async () => {
  const { board, provider } = service();
  await executeBoardTool(
    board,
    scope,
    "board_create",
    {
      workspaceId: "workspace",
      item: {
        title: "Rotate sk-test",
        description: "token sk-test",
        acceptanceCriteria: "sk-test",
      },
    },
    { upkeep: true, secrets: ["sk-test"] },
  );
  expect(provider.create).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Rotate [redacted]",
      description: "token [redacted]",
      acceptanceCriteria: "[redacted]",
      labels: ["bot-filed"],
    }),
  );
  expect(provider.noteFiling).toHaveBeenCalledWith("board-a", {
    runId: "run",
    botId: "builder",
    botName: "Builder",
  });
  await executeBoardTool(
    board,
    scope,
    "board_comment",
    { workspaceId: "workspace", id: "board-a", text: "used sk-test" },
    { upkeep: true, secrets: ["sk-test"] },
  );
  expect(provider.comment).toHaveBeenCalledWith("board-a", "used [redacted]");
});

it("rejects board writes for a read-only grant without calling the provider", async () => {
  const { board, provider } = service();
  const result = await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Task" } },
    { upkeep: true, board: "read", reason: "read-only" },
  );
  expect(result).toEqual({ error: "This board is read-only for this run." });
  expect(provider.create).not.toHaveBeenCalled();
  const shown = await executeBoardTool(
    board,
    scope,
    "board_show",
    { workspaceId: "workspace", id: "board-a" },
    { upkeep: true, board: "read", reason: "read-only" },
  );
  expect(provider.show).toHaveBeenCalled();
  expect(shown).not.toEqual({ error: "This board is read-only for this run." });
});

it("reads bot filing metadata from a Beads item", () => {
  expect(
    parseBeadsItem({
      id: "board-a",
      title: "Task",
      labels: ["bot-filed"],
      metadata: { ardur_run_id: "run", ardur_bot_id: "builder", ardur_filed_by: "Builder" },
    }).filedBy,
  ).toEqual({ botId: "builder", botName: "Builder", runId: "run" });
});

it("leaves board tools unchanged when upkeep is off", async () => {
  const { board, provider } = service({ open: [item("Task")], filings: 5 });
  await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Task", description: "sk-test" } },
    { upkeep: false, secrets: ["sk-test"] },
  );
  expect(provider.create).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Task", description: "sk-test" }),
  );
  expect(provider.noteFiling).not.toHaveBeenCalled();
});
