import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type {
  BoardConfiguration,
  BoardRun,
  BoardRunResult,
  BoardWorkspace,
} from "@ardurbot/contracts/board";
import { BoardError, BoardRunResultSchema } from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import { observeBoardItems } from "@ardurbot/db";
import { BoardRunner } from "@ardurbot/host-runtime/board/runner";
import { getLogger } from "@ardurbot/logging";
import { createHostClient, usesHostBridge } from "../remote-host-sandbox.js";
import { BeadsBoardProvider } from "./beads.js";

export type BoardScope = {
  userId: string;
  spaceId: string;
  botId?: string;
  runId?: string;
  signal?: AbortSignal;
};
export type BoardServiceOptions = {
  prisma: PrismaClient;
  dataDir: string;
  ownerRun?: (request: BoardRun, scope: BoardScope) => Promise<BoardRunResult>;
  localRun?: (request: BoardRun, scope: BoardScope) => Promise<BoardRunResult>;
};
export class BoardService {
  constructor(private readonly options: BoardServiceOptions) {}
  async actor(scope: BoardScope) {
    const [deployment, member] = await Promise.all([
      this.options.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      this.options.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
      }),
    ]);
    if (!member || deployment?.ownerUserId !== scope.userId)
      throw new BoardError({
        code: "forbidden",
        message: "This board is only available to this computer's owner.",
      });
    if (scope.botId) {
      const bot = await this.options.prisma.bot.findFirst({
        where: { id: scope.botId, spaceId: scope.spaceId, userId: scope.userId, archivedAt: null },
        include: { computer: true },
      });
      if (
        !bot ||
        (bot.computer?.kind !== "desktop" &&
          (deployment.computerHost !== "this-mac" || bot.computer?.connectionId))
      )
        throw new BoardError({
          code: "forbidden",
          message: "This bot cannot reach this board's computer.",
        });
      return `bot:${bot.name}`;
    }
    const user = await this.options.prisma.user.findUniqueOrThrow({
      where: { id: scope.userId },
      select: { name: true },
    });
    return user.name.trim() || "Owner";
  }
  async run(request: BoardRun, scope: BoardScope): Promise<BoardRunResult> {
    scope = {
      ...scope,
      signal: AbortSignal.any([
        ...(scope.signal ? [scope.signal] : []),
        AbortSignal.timeout(35_000),
      ]),
    };
    // Never accept identity from model arguments or the browser.
    const actor = await this.actor(scope);
    request = { ...request, actor };
    if (usesHostBridge()) {
      if (!scope.botId) {
        if (!this.options.ownerRun)
          throw new BoardError({ code: "forbidden", message: "Open Board from the app." });
        return this.options.ownerRun(request, scope);
      }
      let stdout = "";
      let result: BoardRunResult | undefined;
      for await (const frame of createHostClient().request(
        { op: "board.run", request },
        scope as Partial<AdapterContext>,
      )) {
        if (frame.channel === "stdout") stdout += String(frame.data);
        if (frame.channel === "result") result = BoardRunResultSchema.parse(frame.data);
      }
      if (!result)
        throw new BoardError({
          code: "invalid_response",
          message: "The host did not return a board result.",
        });
      return result.ok && stdout ? { ...result, stdout } : result;
    }
    if (this.options.localRun) return this.options.localRun(request, scope);
    const registration = await this.options.prisma.hostRegistration.findUnique({
      where: { id: "default" },
    });
    return new BoardRunner({
      root: this.options.dataDir,
      hostRoots: registration?.userId === scope.userId ? registration.hostRoots : [],
    }).run(request, scope.spaceId, scope.signal);
  }
  async workspace(scope: BoardScope, id?: string, options: { allowUninitialized?: boolean } = {}) {
    await this.actor(scope);
    if (!id && scope.botId && scope.runId) {
      const run = await this.options.prisma.run.findFirst({
        where: {
          id: scope.runId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
        },
        select: { boardWorkspaceId: true },
      });
      id = run?.boardWorkspaceId ?? undefined;
    }
    const row = await this.options.prisma.boardWorkspace.findFirst({
      where: {
        ...(id ? { id } : {}),
        spaceId: scope.spaceId,
        ownerUserId: scope.userId,
        enabled: true,
        ...(!id && !options.allowUninitialized ? { initialized: true } : {}),
      },
      ...(!id ? { orderBy: [{ isDefault: "desc" as const }, { createdAt: "asc" as const }] } : {}),
    });
    if (!row || (!row.initialized && !options.allowUninitialized))
      throw new BoardError({ code: "no_board", message: "This folder has no board" });
    if (scope.botId && !row.allowAllBots && !row.allowedBotIds.includes(scope.botId))
      throw new BoardError({
        code: "forbidden",
        message: "This bot is not allowed on this board.",
      });
    return { ...row, ...this.present(row) };
  }
  private present(row: {
    id: string;
    kind: string;
    path: string;
    prefix: string;
    name: string | null;
    enabled: boolean;
    initialized: boolean;
    isDefault: boolean;
    allowAllBots: boolean;
    allowedBotIds: string[];
  }): BoardWorkspace {
    return {
      ...row,
      kind: row.kind as "space" | "folder",
      name: row.name ?? (row.kind === "space" ? "Board" : path.basename(row.path)),
    };
  }
  async configured(scope: BoardScope) {
    await this.actor(scope);
    return (
      await this.options.prisma.boardWorkspace.findMany({
        where: { spaceId: scope.spaceId, ownerUserId: scope.userId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      })
    ).map((row) => this.present(row));
  }
  async configure(scope: BoardScope, id: string, patch: BoardConfiguration) {
    await this.actor(scope);
    if (scope.botId)
      throw new BoardError({ code: "forbidden", message: "Configure this board in Settings." });
    const row = await this.options.prisma.boardWorkspace.findFirst({
      where: { id, spaceId: scope.spaceId, ownerUserId: scope.userId },
    });
    if (!row) throw new BoardError({ code: "forbidden", message: "This board is unavailable." });
    if (patch.isDefault && (!row.initialized || !(patch.enabled ?? row.enabled)))
      throw new BoardError({
        code: "no_board",
        message: "Start this board before making it the default.",
      });
    if (patch.allowedBotIds?.length) {
      const count = await this.options.prisma.bot.count({
        where: {
          id: { in: [...new Set(patch.allowedBotIds)] },
          spaceId: scope.spaceId,
          userId: scope.userId,
          archivedAt: null,
        },
      });
      if (count !== new Set(patch.allowedBotIds).size)
        throw new BoardError({ code: "forbidden", message: "A selected bot is unavailable." });
    }
    const saved = await this.options.prisma.$transaction(async (tx) => {
      // Serialize default changes within this space, including concurrent Settings saves.
      await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${scope.spaceId} FOR UPDATE`;
      if (patch.isDefault)
        await tx.boardWorkspace.updateMany({
          where: { spaceId: scope.spaceId, ownerUserId: scope.userId, isDefault: true },
          data: { isDefault: false },
        });
      return tx.boardWorkspace.update({
        where: { id },
        data: { ...patch, ...(patch.enabled === false ? { isDefault: false } : {}) },
      });
    });
    return this.present(saved);
  }
  async provider(scope: BoardScope, id?: string) {
    const [workspace, actor] = await Promise.all([this.workspace(scope, id), this.actor(scope)]);
    return new BeadsBoardProvider({
      workspace,
      actor,
      run: (request) => this.run(request, scope),
      observe: (items) =>
        observeBoardItems(this.options.prisma, workspace.id, items).catch((error) => {
          // A notification failure cannot turn a successful Beads write into a failed item edit.
          getLogger().error("board follow observation", error);
        }),
    });
  }
  async workspaces(scope: BoardScope) {
    const actor = await this.actor(scope);
    const space = await this.options.prisma.space.findUniqueOrThrow({
      where: { id: scope.spaceId },
      select: { name: true },
    });
    const prefix = `space-${space.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
      .slice(0, 48)
      .replace(/-+$/, "");
    const result = await this.run({ action: "discover", argv: [], actor, prefix }, scope);
    if (!result.ok) return { workspaces: [], problem: result.problem };
    const workspaces: BoardWorkspace[] = [];
    for (const found of result.workspaces ?? []) {
      const row = await this.options.prisma.boardWorkspace.upsert({
        where: { spaceId_path: { spaceId: scope.spaceId, path: found.path } },
        create: {
          spaceId: scope.spaceId,
          ownerUserId: scope.userId,
          kind: found.kind,
          path: found.path,
          prefix: found.prefix,
          initialized: found.initialized,
        },
        update: {
          initialized: found.initialized,
          ...(found.initialized ? { prefix: found.prefix } : {}),
        },
      });
      workspaces.push(this.present(row));
    }
    return { workspaces, problem: null };
  }
  async start(scope: BoardScope, id: string) {
    if (scope.botId)
      throw new BoardError({ code: "forbidden", message: "Start this board from the app." });
    await this.actor(scope);
    const row = await this.options.prisma.boardWorkspace.findFirst({
      where: { id, spaceId: scope.spaceId, ownerUserId: scope.userId, enabled: true },
    });
    if (!row) throw new BoardError({ code: "forbidden", message: "This board is unavailable." });
    const workspace = this.present(row);
    const result = await this.run(
      {
        action: "init",
        workspaceId: workspace.id,
        workspace:
          workspace.kind === "space" ? { kind: "space" } : { kind: "folder", path: workspace.path },
        prefix: workspace.prefix,
        actor: await this.actor(scope),
        argv: [],
      },
      scope,
    );
    if (!result.ok) throw new BoardError(result.problem);
    await this.options.prisma.boardWorkspace.update({ where: { id }, data: { initialized: true } });
    const existing = await this.options.prisma.boardWorkspace.findFirst({
      where: { spaceId: scope.spaceId, ownerUserId: scope.userId, isDefault: true, enabled: true },
    });
    if (!existing) return this.configure(scope, id, { isDefault: true });
    return { ...workspace, initialized: true };
  }
  async assertBotMayClose(scope: BoardScope, workspaceId: string | undefined, ids: string[]) {
    if (!scope.botId || !scope.runId) return;
    const run = await this.options.prisma.run.findFirst({
      where: { id: scope.runId, spaceId: scope.spaceId, userId: scope.userId, botId: scope.botId },
    });
    if (!run?.boardItemId || !ids.includes(run.boardItemId)) return;
    const workspace = await this.workspace(scope, workspaceId);
    if (workspace.id !== run.boardWorkspaceId) return;
    const item = await (await this.provider(scope, workspace.id)).show(run.boardItemId);
    if (!run.boardCloseWhenDone || !item.closeWhenDone)
      throw new BoardError({ code: "forbidden", message: "Closing this item is a human action." });
  }
}
