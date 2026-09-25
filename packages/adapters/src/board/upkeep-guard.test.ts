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

type Filing = Record<string, unknown> & { id: string };
const filingRow = (row: Partial<Filing> & { id: string }): Filing => ({
  spaceId: "space",
  runId: "run",
  botId: null,
  workspaceId: null,
  itemId: null,
  learningProposalId: null,
  reused: false,
  closedAt: null,
  outcome: null,
  createdAt: new Date(),
  ...row,
});
const filingMatches = (row: Filing, where: Record<string, unknown> = {}): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === "OR" && Array.isArray(value))
      return value.some((branch) => filingMatches(row, branch as Record<string, unknown>));
    if (key === "NOT" && value && typeof value === "object" && !(value instanceof Date))
      return !filingMatches(row, value as Record<string, unknown>);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const condition = value as Record<string, unknown>;
      if ("gte" in condition) {
        const left = row[key];
        const right = condition.gte;
        return left instanceof Date && right instanceof Date && left.getTime() >= right.getTime();
      }
      if ("not" in condition)
        return condition.not === null ? row[key] != null : row[key] !== condition.not;
      return true;
    }
    return row[key] === value;
  });

/** A session advisory lock table shared by every client of one fake pool. */
function advisoryPool() {
  const held = new Map<string, number>();
  const state = { open: 0, maxOpen: 0, connects: 0, destroyed: 0 };
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    connect: vi.fn(async () => {
      const client = ++state.connects;
      state.open += 1;
      state.maxOpen = Math.max(state.maxOpen, state.open);
      return {
        query: vi.fn(async (sql: string, values: unknown[] = []) => {
          queries.push({ sql, values });
          const key = String(values[1]);
          if (sql.includes("pg_try_advisory_lock")) {
            if (held.has(key)) return { rows: [{ acquired: false }] };
            held.set(key, client);
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            const owned = held.get(key) === client;
            if (owned) held.delete(key);
            return { rows: [{ released: owned }] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        }),
        release: vi.fn((destroy?: unknown) => {
          state.open -= 1;
          if (destroy) state.destroyed += 1;
        }),
      };
    }),
  };
  return { pool, held, state, queries };
}

function service(options?: {
  open?: WorkItem[];
  filings?: number;
  hourFilings?: number;
  pool?: unknown;
  lockPool?: unknown;
}) {
  const filings: Filing[] = Array.from({ length: options?.filings ?? 0 }, (_, index) =>
    filingRow({ id: `run-${index}` }),
  );
  for (let index = 0; index < (options?.hourFilings ?? 0); index += 1)
    filings.push(filingRow({ id: `hour-${index}`, runId: `other-${index}` }));
  const transactions = { open: 0 };
  const botBoardFiling = {
    count: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        filings.filter((row) => filingMatches(row, where)).length,
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        filings.find((row) => filingMatches(row, where)) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = filingRow({ id: `new-${filings.length}`, ...data });
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
      if (index < 0) throw new Error("Missing filing");
      filings.splice(index, 1);
      return { id: where.id };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const kept = filings.filter((row) => !filingMatches(row, where));
      const count = filings.length - kept.length;
      filings.splice(0, filings.length, ...kept);
      return { count };
    }),
  };
  const prisma = {
    botBoardFiling,
    run: { findFirst: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
    // Enforces the interactive transaction deadline the way Prisma does.
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>, settings?: { timeout?: number }) => {
        const snapshot = filings.map((row) => ({ ...row }));
        let closed = false;
        const guard = <T extends object>(target: T): T =>
          new Proxy(target, {
            get(object, key) {
              const value = Reflect.get(object, key);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                if (closed) throw new Error("Transaction already closed");
                return value.apply(object, args);
              };
            },
          });
        const tx = guard({
          botBoardFiling: guard(botBoardFiling),
          $executeRaw: prisma.$executeRaw,
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        transactions.open += 1;
        try {
          return await Promise.race([
            fn(tx),
            new Promise((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Transaction already closed: timeout")),
                settings?.timeout ?? 5_000,
              );
            }),
          ]);
        } catch (error) {
          filings.splice(0, filings.length, ...snapshot);
          throw error;
        } finally {
          closed = true;
          transactions.open -= 1;
          clearTimeout(timer);
        }
      },
    ),
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
  const board = new BoardService({
    prisma: prisma as never,
    dataDir: "/fixture",
    pool: options?.pool as never,
    lockPool: options?.lockPool as never,
  });
  vi.spyOn(board, "workspace").mockResolvedValue({ id: "workspace" } as never);
  vi.spyOn(board, "provider").mockResolvedValue(provider as never);
  vi.spyOn(board, "actor").mockResolvedValue("bot:Builder");
  return { board, provider, prisma, filings, transactions };
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
  const lock = advisoryPool();
  const { board, provider, prisma } = service({ pool: lock.pool });
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
      titleKey: "rotate [redacted]",
      reused: false,
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

it.each([true, false])(
  "redacts labels, assignee and external references on create and update (upkeep=%s)",
  async (upkeep) => {
    const { board, provider } = service();
    await executeBoardTool(
      board,
      scope,
      "board_create",
      {
        workspaceId: "workspace",
        item: {
          title: "Task",
          labels: ["ops", "key-sk-test"],
          assignee: "sk-test",
          externalRef: "https://tracker.example/sk-test",
        },
      },
      { upkeep, secrets: ["sk-test"] },
    );
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: upkeep ? ["ops", "key-[redacted]", "bot-filed"] : ["ops", "key-[redacted]"],
        assignee: "[redacted]",
        externalRef: "https://tracker.example/[redacted]",
      }),
    );
    await executeBoardTool(
      board,
      scope,
      "board_update",
      {
        workspaceId: "workspace",
        id: "board-a",
        patch: { labels: ["sk-test"], assignee: "owner sk-test", externalRef: "sk-test" },
      },
      { upkeep, secrets: ["sk-test"] },
    );
    expect(provider.update).toHaveBeenCalledWith("board-a", {
      labels: ["[redacted]"],
      assignee: "owner [redacted]",
      externalRef: "[redacted]",
    });
  },
);

it("holds a space session lock, not a transaction, across a create slower than 15 seconds", async () => {
  vi.useFakeTimers();
  try {
    const lock = advisoryPool();
    const { board, provider, filings, transactions } = service({ pool: lock.pool });
    const openAt: number[] = [];
    provider.list.mockImplementation(async () => {
      openAt.push(transactions.open);
      return [];
    });
    provider.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          openAt.push(transactions.open);
          setTimeout(() => resolve(item("Slow")), 16_000);
        }),
    );
    const outcome = executeBoardTool(
      board,
      scope,
      "board_create",
      { workspaceId: "workspace", item: { title: "Slow" } },
      { upkeep: true },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(outcome).resolves.toMatchObject({ id: "board-a" });
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.noteFiling).toHaveBeenCalledOnce();
    expect(openAt).toEqual([0, 0]);
    expect(filings).toEqual([
      expect.objectContaining({ runId: "run", workspaceId: "workspace", itemId: "board-a" }),
    ]);
    expect(lock.queries.map((query) => query.values)).toEqual([
      [1_380_019_075, "space", 4],
      [1_380_019_075, "space", 4],
    ]);
    expect(lock.queries[0]?.sql).toContain("pg_try_advisory_lock(");
    expect(lock.queries[1]?.sql).toContain("pg_advisory_unlock(");
    expect(lock.held.size).toBe(0);
    expect(lock.state).toMatchObject({ open: 0, connects: 1, destroyed: 0 });
  } finally {
    vi.useRealTimers();
  }
});

it("tells the bot to retry when a filing lock stays busy", async () => {
  vi.useFakeTimers();
  try {
    const lock = advisoryPool();
    lock.held.set("space", 0);
    const { board } = service({ pool: lock.pool });
    const outcome = board
      .withFilingLock(scope, async () => "filed")
      .then(
        (value) => value,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(16_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(BoardError);
    expect(error).toMatchObject({
      problem: {
        code: "busy",
        message: "Another write is in progress. Try again in a few seconds.",
      },
    });
  } finally {
    vi.useRealTimers();
  }
});

it("waits a bounded time for another filing in the same space, then reports it busy", async () => {
  vi.useFakeTimers();
  try {
    const lock = advisoryPool();
    lock.held.set("space", 0);
    const { board, provider, filings } = service({ pool: lock.pool });
    const outcome = executeBoardTool(
      board,
      scope,
      "board_create",
      { workspaceId: "workspace", item: { title: "Queued" } },
      { upkeep: true },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(16_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(BoardError);
    expect(error).toMatchObject({
      problem: {
        code: "busy",
        message: "Another write is in progress. Try again in a few seconds.",
      },
    });
    expect(provider.list).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(filings).toEqual([]);
    expect(lock.state.connects).toBeGreaterThan(1);
    expect(lock.state).toMatchObject({ open: 0, maxOpen: 1 });

    const other = await executeBoardTool(
      board,
      { ...scope, spaceId: "space-2" },
      "board_create",
      { workspaceId: "workspace", item: { title: "Elsewhere" } },
      { upkeep: true },
    );
    expect(other).toMatchObject({ id: "board-a" });
    expect(provider.create).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("deletes the reservation when create fails before any item exists", async () => {
  const lock = advisoryPool();
  const { board, provider, filings } = service({ pool: lock.pool });
  provider.create.mockRejectedValueOnce(
    new BoardError({ code: "command_failed", message: "Beads could not finish this change." }),
  );
  await expect(
    executeBoardTool(
      board,
      scope,
      "board_create",
      { workspaceId: "workspace", item: { title: "Rejected" } },
      { upkeep: true },
    ),
  ).rejects.toMatchObject({ problem: { code: "command_failed" } });
  expect(filings).toEqual([]);
  expect(lock.held.size).toBe(0);
});

it("repairs missing filing metadata when the same run finds the item it filed", async () => {
  const mine = service({ open: [item("Task")] });
  mine.filings.push(filingRow({ id: "mine", workspaceId: "workspace", itemId: "board-a" }));
  const result = await executeBoardTool(
    mine.board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "task" } },
    { upkeep: true },
  );
  expect(mine.provider.noteFiling).toHaveBeenCalledWith("board-a", {
    runId: "run",
    botId: "builder",
    botName: "Builder",
  });
  expect(result).toMatchObject({
    duplicate: true,
    item: { id: "board-a", filedBy: { runId: "run" } },
    message: "An open item already has this title: board-a.",
  });
  expect(mine.provider.create).not.toHaveBeenCalled();

  const theirs = service({ open: [item("Task")] });
  theirs.filings.push(
    filingRow({ id: "theirs", runId: "other", workspaceId: "workspace", itemId: "board-a" }),
  );
  await executeBoardTool(
    theirs.board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "task" } },
    { upkeep: true },
  );
  expect(theirs.provider.noteFiling).not.toHaveBeenCalled();
});

it("records a proposal's reuse of an open item and returns its own filing on retry", async () => {
  const learningScope = { userId: "owner", spaceId: "space", botId: "builder" };
  const reused = service({ open: [item("Recurring failure")] });
  await reused.board.fileLearningProposal(
    learningScope,
    "proposal",
    { title: "recurring failure", description: "", acceptanceCriteria: "Resolved" },
    [],
  );
  expect(reused.filings).toEqual([
    expect.objectContaining({
      runId: null,
      botId: "builder",
      workspaceId: "workspace",
      itemId: "board-a",
      learningProposalId: "proposal",
      reused: true,
    }),
  ]);

  const filed = service();
  const shown = item("Task");
  filed.provider.show.mockResolvedValue(shown);
  const first = await filed.board.fileLearningProposal(
    learningScope,
    "proposal",
    { title: "Task", description: "", acceptanceCriteria: "Done" },
    [],
  );
  filed.provider.list.mockResolvedValue([]);
  const retry = await filed.board.fileLearningProposal(
    learningScope,
    "proposal",
    { title: "Task", description: "", acceptanceCriteria: "Done" },
    [],
  );
  expect(filed.provider.create).toHaveBeenCalledOnce();
  expect(filed.provider.show).toHaveBeenCalledWith("board-a");
  expect(retry).toEqual({ ...first, item: shown });
  expect(filed.filings).toHaveLength(1);
});

it("acquires the filing lock from its own pool when the shared pool is exhausted", async () => {
  const shared = advisoryPool();
  shared.pool.connect.mockImplementation(async () => {
    throw new Error("timeout exceeded when trying to connect");
  });
  const locks = advisoryPool();
  const { board } = service({ pool: shared.pool, lockPool: locks.pool });
  await expect(board.withFilingLock(scope, async () => "filed")).resolves.toBe("filed");
  expect(locks.pool.connect).toHaveBeenCalled();
  expect(shared.pool.connect).not.toHaveBeenCalled();
});

it("keeps a created item on its reservation when recording the id fails, then the same run attaches it", async () => {
  const { board, provider, filings, prisma } = service();
  const created = item("Ship the board");
  created.createdAt = new Date(Date.now() + 5_000).toISOString();
  provider.create.mockResolvedValue(created);
  const update = prisma.botBoardFiling.update.getMockImplementation();
  prisma.botBoardFiling.update.mockImplementation(async () => {
    throw new Error("timeout exceeded when trying to connect");
  });
  await expect(
    executeBoardTool(
      board,
      scope,
      "board_create",
      { workspaceId: "workspace", item: { title: "Ship the board" } },
      { upkeep: true },
    ),
  ).rejects.toThrow(/timeout exceeded when trying to connect/);
  expect(filings).toEqual([
    expect.objectContaining({ id: expect.any(String), itemId: null, workspaceId: null }),
  ]);
  expect(provider.create).toHaveBeenCalledOnce();
  prisma.botBoardFiling.update.mockImplementation(update!);
  provider.list.mockResolvedValue([created]);
  const retry = await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "ship the board" } },
    { upkeep: true },
  );
  expect(provider.create).toHaveBeenCalledOnce();
  expect(retry).not.toMatchObject({ duplicate: true });
  expect(filings).toEqual([
    expect.objectContaining({ itemId: "board-a", workspaceId: "workspace" }),
  ]);
});

it("ignores hollow reservations older than 15 minutes for both filing caps", async () => {
  const stale = new Date(Date.now() - 20 * 60 * 1000);
  const run = service();
  for (let index = 0; index < 5; index += 1)
    run.filings.push(filingRow({ id: `stale-run-${index}`, itemId: null, createdAt: stale }));
  const filed = await executeBoardTool(
    run.board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "After the stale reservations" } },
    { upkeep: true },
  );
  expect(filed).not.toHaveProperty("error");
  expect(run.provider.create).toHaveBeenCalledOnce();

  const fresh = service();
  for (let index = 0; index < 5; index += 1)
    fresh.filings.push(
      filingRow({ id: `fresh-run-${index}`, itemId: null, createdAt: new Date() }),
    );
  const blocked = await executeBoardTool(
    fresh.board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Still inside the window" } },
    { upkeep: true },
  );
  expect(blocked).toEqual({
    error:
      "This run already filed 5 board items. Comment on an existing item instead of creating another.",
  });

  const learningScope = { userId: "owner", spaceId: "space", botId: "builder" };
  const hour = service();
  for (let index = 0; index < 30; index += 1)
    hour.filings.push(
      filingRow({
        id: `stale-hour-${index}`,
        runId: null,
        itemId: null,
        reused: false,
        createdAt: stale,
      }),
    );
  await expect(
    hour.board.fileLearningProposal(
      learningScope,
      "proposal",
      {
        title: "After the hour of hollow reservations",
        description: "",
        acceptanceCriteria: "Done",
      },
      [],
    ),
  ).resolves.toMatchObject({ duplicate: false });
  expect(hour.provider.create).toHaveBeenCalledOnce();
});

/** Two connections, and a checkout past that rejects the way node-pg does when the pool is full. */
function cappedAdvisoryPool(max: number) {
  const held = new Map<string, number>();
  const state = { open: 0, maxOpen: 0, connects: 0, rejected: 0 };
  let next = 0;
  const pool = {
    connect: vi.fn(async () => {
      if (state.open >= max) {
        state.rejected += 1;
        throw new Error("timeout exceeded when trying to connect");
      }
      const client = ++next;
      state.connects += 1;
      state.open += 1;
      state.maxOpen = Math.max(state.maxOpen, state.open);
      return {
        query: vi.fn(async (sql: string, values: unknown[] = []) => {
          const key = String(values[1]);
          if (sql.includes("pg_try_advisory_lock")) {
            if (held.has(key)) return { rows: [{ acquired: false }] };
            held.set(key, client);
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            if (held.get(key) === client) held.delete(key);
            return { rows: [{ released: true }] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        }),
        release: vi.fn(() => {
          state.open -= 1;
        }),
      };
    }),
  };
  return { pool, state };
}

it("waits when the lock pool is exhausted and reports busy only after the deadline", async () => {
  vi.useFakeTimers();
  const blocked = new Map<string, (value: WorkItem) => void>();
  const release = (title: string) => {
    const resolve = blocked.get(title);
    if (!resolve) throw new Error(`No held filing for ${title}`);
    blocked.delete(title);
    resolve(item(title));
  };
  try {
    const scenario = async (waiterTitle: string) => {
      const lock = cappedAdvisoryPool(2);
      const { board, provider } = service({ lockPool: lock.pool });
      provider.create.mockImplementation((input?: { title?: string }) => {
        const name = input?.title ?? "";
        if (name === waiterTitle) return Promise.resolve(item(name));
        return new Promise<WorkItem>((resolve) => {
          blocked.set(name, resolve);
        });
      });
      const file = (id: string, itemTitle: string) =>
        executeBoardTool(
          board,
          { ...scope, spaceId: id, runId: `run-${id}` },
          "board_create",
          { workspaceId: "workspace", item: { title: itemTitle } },
          { upkeep: true },
        );
      const heldA = file("space-a", "Hold A");
      const heldB = file("space-b", "Hold B");
      await vi.advanceTimersByTimeAsync(0);
      expect(lock.state).toMatchObject({ open: 2, maxOpen: 2 });
      const waiting = file("space-c", waiterTitle);
      await vi.advanceTimersByTimeAsync(0);
      expect(lock.state.rejected).toBeGreaterThan(0);
      expect(lock.state.maxOpen).toBe(2);
      return { lock, heldA, heldB, waiting, provider };
    };

    const finished = await scenario("Third");
    release("Hold A");
    await vi.advanceTimersByTimeAsync(0);
    expect(finished.lock.state.open).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    await expect(finished.waiting).resolves.toMatchObject({ id: "board-a" });
    expect(finished.provider.create).toHaveBeenCalledTimes(3);
    release("Hold B");
    await vi.advanceTimersByTimeAsync(0);

    const busy = await scenario("Late");
    const settled = expect(busy.waiting).rejects.toMatchObject({
      problem: {
        code: "busy",
        message: "Another write is in progress. Try again in a few seconds.",
      },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(busy.provider.create).toHaveBeenCalledTimes(2);
  } finally {
    for (const resolve of blocked.values()) resolve(item("Released"));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  }
});

it("claims a hollow reservation only for its own title and does not take an item that is already filed", async () => {
  const other = item("Write the notes");
  other.id = "board-b";
  const missed = service({ open: [other] });
  missed.filings.push(
    filingRow({ id: "hollow", itemId: null, titleKey: "ship the board", createdAt: new Date() }),
  );
  const wrong = await executeBoardTool(
    missed.board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Write the notes" } },
    { upkeep: true },
  );
  expect(wrong).toMatchObject({
    duplicate: true,
    item: { id: "board-b" },
    message: "An open item already has this title: board-b.",
  });
  expect(missed.filings.find((row) => row.id === "hollow")).toMatchObject({
    itemId: null,
    titleKey: "ship the board",
  });
  expect(missed.provider.create).not.toHaveBeenCalled();

  const owned = item("Ship the board");
  const taken = service({ open: [owned] });
  taken.filings.push(filingRow({ id: "hollow", itemId: null, titleKey: "ship the board" }));
  taken.filings.push(
    filingRow({
      id: "owner",
      runId: null,
      workspaceId: "workspace",
      itemId: "board-a",
      learningProposalId: "proposal",
      reused: false,
    }),
  );
  const update = taken.prisma.botBoardFiling.update.getMockImplementation()!;
  taken.prisma.botBoardFiling.update.mockImplementation(async (args) => {
    const data = args.data as { itemId?: string | null; workspaceId?: string | null };
    if (data.itemId) {
      const clash = taken.filings.some(
        (row) =>
          row.id !== args.where.id &&
          row.itemId === data.itemId &&
          row.reused !== true &&
          (row.workspaceId ?? data.workspaceId) === (data.workspaceId ?? row.workspaceId),
      );
      if (clash)
        throw new Error("Unique constraint failed on the fields: (`workspaceId`,`itemId`)");
    }
    return update(args);
  });
  await expect(
    executeBoardTool(
      taken.board,
      scope,
      "board_create",
      { workspaceId: "workspace", item: { title: "Ship the board" } },
      { upkeep: true },
    ),
  ).resolves.toMatchObject({
    duplicate: true,
    item: { id: "board-a" },
    message: "An open item already has this title: board-a.",
  });
  expect(taken.filings.find((row) => row.id === "hollow")).toMatchObject({ itemId: null });
  expect(taken.provider.create).not.toHaveBeenCalled();
});

it("does not claim a next-day item from a hollow reservation on the tool path", async () => {
  const later = item("Ship the board");
  later.createdAt = new Date(Date.now() + 86_400_000).toISOString();
  const { board, provider, filings } = service({ open: [later] });
  filings.push(
    filingRow({
      id: "hollow",
      itemId: null,
      titleKey: "ship the board",
      createdAt: new Date(),
    }),
  );
  const result = await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Ship the board" } },
    { upkeep: true },
  );
  expect(result).toMatchObject({
    duplicate: true,
    item: { id: "board-a" },
  });
  expect(filings.find((row) => row.id === "hollow")).toMatchObject({ itemId: null });
  expect(provider.create).not.toHaveBeenCalled();
});

it("does not claim an item another run filed from a hollow reservation on the tool path", async () => {
  const theirs = item("Ship the board");
  theirs.createdAt = new Date().toISOString();
  theirs.filedBy = {
    runId: "other-run",
    botId: "other",
    botName: "Other",
    groupId: null,
    messageId: null,
  };
  const { board, provider, filings } = service({ open: [theirs] });
  filings.push(
    filingRow({
      id: "hollow",
      itemId: null,
      titleKey: "ship the board",
      createdAt: new Date(Date.now() - 60_000),
    }),
  );
  const result = await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Ship the board" } },
    { upkeep: true },
  );
  expect(result).toMatchObject({ duplicate: true, item: { id: "board-a" } });
  expect(filings.find((row) => row.id === "hollow")).toMatchObject({ itemId: null });
  expect(provider.create).not.toHaveBeenCalled();
});

it("claims a hollow reservation for an item created inside the window with no filer", async () => {
  const owned = item("Ship the board");
  const reservedAt = new Date(Date.now() - 60_000);
  owned.createdAt = new Date(reservedAt.getTime() + 30_000).toISOString();
  const { board, provider, filings } = service({ open: [owned] });
  filings.push(
    filingRow({ id: "hollow", itemId: null, titleKey: "ship the board", createdAt: reservedAt }),
  );
  const result = await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "ship the board" } },
    { upkeep: true },
  );
  expect(result).not.toMatchObject({ duplicate: true });
  expect(filings).toEqual([
    expect.objectContaining({ id: "hollow", itemId: "board-a", workspaceId: "workspace" }),
  ]);
  expect(provider.create).not.toHaveBeenCalled();
});

it("deletes a hollow reservation older than 15 minutes and creates a new item on the tool path", async () => {
  const reservedAt = new Date(Date.now() - 20 * 60_000);
  const later = item("Ship the board");
  later.id = "board-later";
  later.createdAt = new Date(reservedAt.getTime() + 60_000).toISOString();
  const { board, provider, filings } = service({ open: [later] });
  filings.push(
    filingRow({ id: "hollow", itemId: null, titleKey: "ship the board", createdAt: reservedAt }),
  );
  const result = await executeBoardTool(
    board,
    scope,
    "board_create",
    { workspaceId: "workspace", item: { title: "Ship the board" } },
    { upkeep: true },
  );
  expect(filings.some((row) => row.id === "hollow")).toBe(false);
  expect(provider.create).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ id: "board-a" });
  expect(result).not.toMatchObject({ duplicate: true });
  expect(filings.some((row) => row.itemId === "board-later")).toBe(false);
});
