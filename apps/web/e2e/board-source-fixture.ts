import { rm } from "node:fs/promises";
import path from "node:path";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type { BoardRun } from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import type { BoardScope } from "../../../packages/adapters/src/board/service";
import { BoardService } from "../../../packages/adapters/src/board/service";
import { boardFixture } from "../../../packages/adapters/src/board/test-fixture";
import {
  executeBoardCommand,
  requestBoardCommand,
} from "../../../packages/adapters/src/board/worker";

/** Real service/worker/runner, with persistence, the queue and bd faked. */
export async function sourceBoardFixture() {
  const fixture = await boardFixture();
  await rm(path.join(fixture.workspace.path, ".beads"), { recursive: true });
  const actor = { userId: "fixture-user", spaceId: "space" } as Actor;
  type Workspace = {
    id: string;
    spaceId: string;
    ownerUserId: string;
    kind: string;
    path: string;
    prefix: string;
    initialized: boolean;
    enabled: boolean;
    name: string | null;
    isDefault: boolean;
    allowAllBots: boolean;
    allowedBotIds: string[];
  };
  type Command = {
    id: string;
    spaceId: string;
    userId: string;
    request: BoardRun;
    expiresAt: Date;
    status: string;
    result: unknown;
  };
  const workspaces: Workspace[] = [];
  const commands = new Map<string, Command>();
  let sequence = 0;
  const matching = (where: Record<string, unknown>) =>
    workspaces
      .filter((row) =>
        Object.entries(where).every(([key, value]) => row[key as keyof Workspace] === value),
      )
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const database = {
    deploymentSettings: {
      findUnique: async () => ({ ownerUserId: actor.userId, computerHost: "this-mac" }),
    },
    spaceMember: { findUnique: async () => ({ userId: actor.userId }) },
    user: { findUniqueOrThrow: async () => ({ name: "Owner" }) },
    space: { findUniqueOrThrow: async () => ({ name: "Workspace" }) },
    bot: { findMany: async () => [] },
    boardFollow: { findMany: async () => [] },
    boardWorkspace: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        matching(where)[0] ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => matching(where),
      upsert: async ({
        create,
        update,
      }: {
        create: Partial<Workspace>;
        update: Partial<Workspace>;
      }) => {
        const existing = workspaces.find((row) => row.path === create.path);
        if (existing) return Object.assign(existing, update);
        const row = {
          id: `workspace-${workspaces.length}`,
          enabled: true,
          name: null,
          isDefault: false,
          allowAllBots: true,
          allowedBotIds: [],
          ...create,
        } as Workspace;
        workspaces.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Workspace> }) =>
        Object.assign(matching(where)[0]!, data),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<Workspace>;
      }) => {
        const rows = matching(where);
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    boardCommand: {
      create: async ({ data }: { data: Omit<Command, "id" | "status" | "result"> }) => {
        const row = { ...data, id: `command-${sequence++}`, status: "queued", result: null };
        commands.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => commands.get(where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Partial<Command>;
      }) => {
        const row = commands.get(where.id);
        if (!row || row.status !== where.status || row.expiresAt.getTime() <= Date.now())
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: { id?: string } }) => ({
        count: where.id && commands.delete(where.id) ? 1 : 0,
      }),
    },
    $queryRaw: async () => [],
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(database),
  };
  const prisma = database as unknown as PrismaClient;
  const worker = {
    prisma,
    dataDir: fixture.root,
    localRun: (request: BoardRun, scope: BoardScope) =>
      fixture.runner.run(request, scope.spaceId, scope.signal),
  };
  const jobs = {
    enqueue: async ({ payload }: { payload: { requestId: string } }) =>
      executeBoardCommand(worker, payload.requestId),
  };
  const service = new BoardService({
    prisma,
    dataDir: fixture.root,
    localRun: (request, scope) =>
      requestBoardCommand({ prisma, jobs: jobs as unknown as JobPublisher }, request, scope),
  });
  const hostBridge = process.env.ARDURBOT_HOST_BRIDGE;
  delete process.env.ARDURBOT_HOST_BRIDGE;
  return {
    clean: async () => {
      try {
        await fixture.clean();
      } finally {
        if (hostBridge === undefined) delete process.env.ARDURBOT_HOST_BRIDGE;
        else process.env.ARDURBOT_HOST_BRIDGE = hostBridge;
      }
    },
    calls: fixture.calls,
    async rpc(procedure: string, input: { workspaceId?: string; itemId?: string } = {}) {
      if (procedure === "board/workspaces") return service.workspaces(actor);
      if (procedure === "board/start") return service.start(actor, input.workspaceId!);
      // Settings reads the upkeep switch next to the boards; the source worker does not own it.
      if (procedure === "board/upkeep") return { enabled: true };
      if (procedure === "board/view") {
        const workspaces = (await service.configured(actor)).filter(
          (row) => row.initialized && row.enabled,
        );
        const workspace = workspaces[0];
        const provider = workspace ? await service.provider(actor, workspace.id) : null;
        return {
          workspaces,
          workspaceId: workspace?.id ?? null,
          snapshot: {
            items: provider ? await provider.list() : [],
            readyIds: provider ? (await provider.ready()).map((item) => item.id) : [],
            blockedIds: provider ? (await provider.blocked()).map((item) => item.id) : [],
          },
          selected: null,
          followingIds: [],
          bots: [],
          problem: null,
        };
      }
      throw new Error(`Unexpected source Board procedure: ${procedure}`);
    },
  };
}
