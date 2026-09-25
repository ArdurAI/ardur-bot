import { ALL_DEVICE_SCOPES } from "@ardurbot/contracts";
import { BoardError, type WorkItem } from "@ardurbot/contracts/board";
import { expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "../executor.js";
import { agentToolsForRequest } from "../pi-runtime.js";
import { currentRemoteDecision, enforceRemoteExecution } from "../remote-execution.js";
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
  resolveBoardAccess,
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
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        const row = filings.find((item) => item.id === where.id);
        if (!row) throw new Error("Missing filing");
        Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = filings.findIndex((row) => row.id === where.id);
        if (index >= 0) filings.splice(index, 1);
        return { id: where.id };
      }),
    },
    run: { findFirst: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = filings.map((row) => ({ ...row }));
      try {
        return await fn(prisma);
      } catch (error) {
        filings.splice(0, filings.length, ...snapshot);
        throw error;
      }
    }),
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
  vi.spyOn(board, "workspace").mockResolvedValue({ id: "workspace" } as never);
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
  const { board, provider, prisma } = service();
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
  expect(prisma.botBoardFiling.update).toHaveBeenCalledWith({
    where: { id: "new-0" },
    data: { workspaceId: "workspace", itemId: "board-a" },
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
  ).toEqual({
    botId: "builder",
    botName: "Builder",
    runId: "run",
    groupId: null,
    messageId: null,
  });
});

it("redacts run secrets from a board create and comment when upkeep is off", async () => {
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
    { upkeep: false, secrets: ["sk-test"] },
  );
  expect(provider.create).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Rotate [redacted]",
      description: "token [redacted]",
      acceptanceCriteria: "[redacted]",
    }),
  );
  await executeBoardTool(
    board,
    scope,
    "board_comment",
    { workspaceId: "workspace", id: "board-a", text: "used sk-test" },
    { upkeep: false, secrets: ["sk-test"] },
  );
  expect(provider.comment).toHaveBeenCalledWith("board-a", "used [redacted]");
  await executeBoardTool(
    board,
    scope,
    "board_close",
    { workspaceId: "workspace", ids: ["board-a"], reason: "done sk-test" },
    { upkeep: false, secrets: ["sk-test"] },
  );
  expect(provider.close).toHaveBeenCalledWith(["board-a"], "done [redacted]");
});

it("keeps the filing when create reports the item already exists", async () => {
  const { board, provider, prisma } = service({ filings: 4 });
  provider.create.mockRejectedValueOnce(
    new BoardError({
      code: "created_incomplete",
      message:
        "Item board-new was created, but its details could not finish. Open it before retrying.",
      itemId: "board-new",
    }),
  );
  await expect(
    executeBoardTool(
      board,
      scope,
      "board_create",
      { workspaceId: "workspace", item: { title: "Partial" } },
      { upkeep: true },
    ),
  ).rejects.toMatchObject({ problem: { code: "created_incomplete", itemId: "board-new" } });
  expect(prisma.botBoardFiling.delete).not.toHaveBeenCalled();
  expect(prisma.botBoardFiling.update).toHaveBeenCalledWith({
    where: { id: "new-4" },
    data: { workspaceId: "workspace", itemId: "board-new" },
  });
  provider.create.mockResolvedValue(item("Next"));
  const next = await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Next" } },
    { upkeep: true },
  );
  expect(next).toEqual({
    error:
      "This run already filed 5 board items. Comment on an existing item instead of creating another.",
  });
  expect(provider.create).toHaveBeenCalledTimes(1);
});

it("serializes same-title filings so only one item is created", async () => {
  const { board, provider, prisma } = service();
  const open: WorkItem[] = [];
  let releaseFirst: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let createdCount = 0;
  provider.list.mockImplementation(async () => open.map((row) => ({ ...row })));
  provider.create.mockImplementation(async (createdItem?: { title?: string }) => {
    createdCount += 1;
    const created = item(createdItem?.title ?? "Ship the board");
    created.id = `board-${createdCount}`;
    if (createdCount === 1) await gate;
    open.push(created);
    return created;
  });
  let chain = Promise.resolve();
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const run = chain.then(async () => {
      const snapshot = [...open];
      try {
        return await fn(prisma);
      } catch (error) {
        open.splice(0, open.length, ...snapshot);
        throw error;
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
  const pending = Promise.all([
    executeBoardTool(
      board,
      scope,
      "board_create",
      { workspaceId: "workspace", item: { title: "Ship the board" } },
      { upkeep: true },
    ),
    executeBoardTool(
      board,
      { ...scope, runId: "run-b" },
      "board_create",
      { workspaceId: "workspace", item: { title: "Ship the board" } },
      { upkeep: true },
    ),
  ]);
  const started = Date.now();
  while (provider.create.mock.calls.length < 1) {
    if (Date.now() - started > 1000) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  let results: unknown[] = [];
  try {
    expect(provider.create).toHaveBeenCalledTimes(1);
  } finally {
    releaseFirst();
    results = await pending;
  }
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(prisma.botBoardFiling.create).toHaveBeenCalledTimes(1);
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        duplicate: true,
        message: "An open item already has this title: board-1.",
      }),
    ]),
  );
});

it("files learning proposals through redaction, dedupe and the hourly cap", async () => {
  const learningScope = { userId: "owner", spaceId: "space", botId: "builder" };
  const redacted = service();
  await redacted.board.fileLearningProposal(
    learningScope,
    "proposal",
    {
      title: "Rotate sk-test",
      description: "Remove sk-test",
      acceptanceCriteria: "sk-test is gone",
    },
    ["sk-test"],
  );
  expect(redacted.provider.create).toHaveBeenCalledWith({
    title: "Rotate [redacted]",
    description: "Remove [redacted]",
    acceptanceCriteria: "[redacted] is gone",
    labels: ["bot-filed"],
    priority: 2,
    type: "task",
  });
  expect(redacted.prisma.botBoardFiling.create).toHaveBeenCalledWith({
    data: {
      spaceId: "space",
      runId: null,
      botId: "builder",
      workspaceId: "workspace",
      learningProposalId: "proposal",
    },
  });

  const duplicate = service({ open: [item("Recurring failure")] });
  await expect(
    duplicate.board.fileLearningProposal(
      learningScope,
      "proposal",
      {
        title: " recurring   failure ",
        description: "",
        acceptanceCriteria: "Resolved",
      },
      [],
    ),
  ).resolves.toMatchObject({ duplicate: true, item: { id: "board-a" } });
  expect(duplicate.provider.create).not.toHaveBeenCalled();

  const capped = service({ hourFilings: 30 });
  await expect(
    capped.board.fileLearningProposal(
      learningScope,
      "proposal",
      { title: "New", description: "", acceptanceCriteria: "Resolved" },
      [],
    ),
  ).rejects.toThrow("30 board items");
  expect(capped.provider.create).not.toHaveBeenCalled();
});

function workspaceRow(id: string, admitted: boolean, isDefault = false) {
  return {
    id,
    spaceId: "space",
    ownerUserId: "owner",
    kind: id === "folder" ? "folder" : "space",
    path: id === "folder" ? "/fixture/folder" : "/fixture/board",
    prefix: "work",
    name: id,
    enabled: true,
    initialized: true,
    isDefault,
    allowAllBots: false,
    allowedBotIds: admitted ? ["builder"] : [],
    createdAt: new Date(0),
  };
}

function phoneBoard(options: {
  scopes: readonly string[];
  lastPresenceAt: Date | null;
  boards: ReturnType<typeof workspaceRow>[];
}) {
  const grant = {
    id: "phone",
    instanceId: "home",
    spaceId: "space",
    userId: "owner",
    scopes: options.scopes,
    revokedAt: null as Date | null,
    lastPresenceAt: options.lastPresenceAt,
    trustedAt: new Date(),
    kind: "device",
  };
  const run = {
    id: "run",
    botId: "builder",
    taskId: "task",
    spaceId: "space",
    userId: "owner",
    originDeviceGrantId: "phone",
    remoteDeviceGrantIds: ["phone"],
    cancelRequestedAt: null,
    status: "running",
  };
  const prisma = {
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "owner", computerHost: "this-mac" })),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member", userId: "owner" })) },
    user: { findUniqueOrThrow: vi.fn(async () => ({ name: "Owner" })) },
    bot: {
      findFirst: vi.fn(async () => ({
        id: "builder",
        name: "Builder",
        computer: { kind: "desktop" },
      })),
    },
    run: {
      findUnique: vi.fn(async () => run),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    deviceGrant: {
      findUnique: vi.fn(async () => grant),
      findFirst: vi.fn(async () => (grant.revokedAt ? null : grant)),
    },
    instanceIdentity: {
      findUnique: vi.fn(async () => ({ instanceId: "home", scopes: [...ALL_DEVICE_SCOPES] })),
    },
    remoteAuthorityPolicy: { findMany: vi.fn(async () => []) },
    deviceAuditEvent: { create: vi.fn(async () => ({})) },
    space: { findUniqueOrThrow: vi.fn(async () => ({ requireTrustedDevices: false })) },
    boardWorkspace: {
      findMany: vi.fn(async () => options.boards),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          options.boards.find((row) =>
            Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
          ) ?? null,
      ),
    },
  };
  const board = new BoardService({ prisma: prisma as never, dataDir: "/fixture" });
  return { prisma, board, grant };
}

const phoneScope = { userId: "owner", spaceId: "space", botId: "builder", runId: "run" };

it("keeps board writes when phone presence is stale and pauses board_create", async () => {
  const { prisma, board } = phoneBoard({
    scopes: ALL_DEVICE_SCOPES,
    lastPresenceAt: new Date(Date.now() - 11 * 60_000),
    boards: [{ ...workspaceRow("default", true, true), allowAllBots: true, allowedBotIds: [] }],
  });
  const decision = await currentRemoteDecision(prisma as never, "run", "board_create");
  expect(decision).toMatchObject({
    allowed: false,
    kind: "presence",
    action: "Confirm on your phone",
  });
  const access = await resolveBoardAccess(board, prisma as never, phoneScope);
  expect(access).toMatchObject({ board: "write", reason: null });
  expect(
    botUpkeepPrompt({
      enabled: true,
      board: access.board,
      reason: access.reason,
      memory: true,
      workspaceIds: access.workspaceIds,
    }),
  ).not.toContain("This board is read-only for this run.");
  expect(names(access.board)).toContain("board_create");
  const pause = vi.fn(async (_reason: string, _action: string) => undefined);
  expect(
    await enforceRemoteExecution({
      prisma: prisma as never,
      runId: "run",
      tool: "board_create",
      pause,
    }),
  ).toBe(false);
  expect(
    await enforceRemoteExecution({ prisma: prisma as never, runId: "run", tool: "shell", pause }),
  ).toBe(false);
  expect(pause.mock.calls.map((call) => call[1])).toEqual([
    "Confirm on your phone",
    "Confirm on your phone",
  ]);
});

it("keeps an ordinary grant read-only", async () => {
  const { prisma, board } = phoneBoard({
    scopes: ["dispatch", "ordinary"],
    lastPresenceAt: new Date(),
    boards: [{ ...workspaceRow("default", true, true), allowAllBots: true, allowedBotIds: [] }],
  });
  const decision = await currentRemoteDecision(prisma as never, "run", "board_create");
  expect(decision).toMatchObject({
    allowed: false,
    kind: "authority",
    action: "Approve on your Mac",
  });
  const access = await resolveBoardAccess(board, prisma as never, phoneScope);
  expect(access).toMatchObject({ board: "read", reason: "read-only" });
  expect(
    botUpkeepPrompt({
      enabled: true,
      board: access.board,
      reason: access.reason,
      memory: true,
      workspaceIds: access.workspaceIds,
    }),
  ).toContain("This board is read-only for this run.");
  expect(names(access.board)).toContain("board_show");
  expect(names(access.board)).not.toContain("board_create");
});

it("shows a folder board when the default board excludes the bot", async () => {
  const { prisma, board } = phoneBoard({
    scopes: ALL_DEVICE_SCOPES,
    lastPresenceAt: new Date(),
    boards: [workspaceRow("default", false, true), workspaceRow("folder", true)],
  });
  const provider = { show: vi.fn(async () => item("Task")) };
  vi.spyOn(board, "provider").mockImplementation(async (callScope, id) => {
    await BoardService.prototype.workspace.call(board, callScope, id);
    return provider as never;
  });
  const shown = await executeBoardTool(
    board,
    phoneScope,
    "board_show",
    { workspaceId: "folder", id: "board-a" },
    { upkeep: true, board: "none", reason: "no-board" },
  );
  expect(provider.show).toHaveBeenCalledWith("board-a");
  expect(shown).not.toEqual({ error: "This space has no board this bot can use." });
  const access = await resolveBoardAccess(board, prisma as never, phoneScope);
  expect(access.board).toBe("write");
  expect(names(access.board)).toContain("board_create");
  expect(
    botUpkeepPrompt({
      enabled: true,
      board: access.board,
      reason: access.reason,
      memory: true,
      workspaceIds: access.workspaceIds,
    }),
  ).toContain("Pass workspaceId folder.");
  const denied = await executeBoardTool(
    board,
    phoneScope,
    "board_show",
    { workspaceId: "default", id: "board-a" },
    { upkeep: true, board: "write", reason: null },
  );
  expect(denied).toEqual({ error: "Pass workspaceId folder." });
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
    expect.objectContaining({ title: "Task", description: "[redacted]" }),
  );
  expect(provider.noteFiling).not.toHaveBeenCalled();
});
