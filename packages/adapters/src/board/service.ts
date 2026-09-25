import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { BoardRun, BoardRunResult, BoardWorkspace } from "@ardurbot/contracts/board";
import { BoardError, BoardRunResultSchema } from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import { BoardRunner } from "@ardurbot/host-runtime/board/runner";
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
  async workspace(scope: BoardScope, id?: string) {
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
    let row = await this.options.prisma.boardWorkspace.findFirst({
      where: {
        ...(id ? { id } : { kind: "space" }),
        spaceId: scope.spaceId,
        ownerUserId: scope.userId,
        enabled: true,
      },
    });
    if (!row && !id) {
      const discovered = await this.workspaces(scope);
      if (discovered.problem) throw new BoardError(discovered.problem);
      row = await this.options.prisma.boardWorkspace.findFirst({
        where: { kind: "space", spaceId: scope.spaceId, ownerUserId: scope.userId, enabled: true },
      });
    }
    if (!row) throw new BoardError({ code: "no_board", message: "This folder has no board" });
    return {
      ...row,
      kind: row.kind as "space" | "folder",
      name: row.kind === "space" ? "Board" : path.basename(row.path),
      initialized: true,
    } satisfies BoardWorkspace;
  }
  async provider(scope: BoardScope, id?: string) {
    const [workspace, actor] = await Promise.all([this.workspace(scope, id), this.actor(scope)]);
    return new BeadsBoardProvider({ workspace, actor, run: (request) => this.run(request, scope) });
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
        },
        update: found.initialized ? { prefix: found.prefix } : {},
      });
      let initialized = found.initialized;
      if (found.kind === "space" && !initialized && row.enabled) {
        const started = await this.run(
          {
            action: "init",
            workspaceId: row.id,
            workspace: { kind: "space" },
            prefix: row.prefix,
            actor,
            argv: [],
          },
          scope,
        );
        if (!started.ok) return { workspaces, problem: started.problem };
        initialized = true;
      }
      workspaces.push({
        ...found,
        id: row.id,
        prefix: row.prefix,
        enabled: row.enabled,
        initialized,
      });
    }
    return { workspaces, problem: null };
  }
  async start(scope: BoardScope, id: string) {
    if (scope.botId)
      throw new BoardError({ code: "forbidden", message: "Start this board from the app." });
    const workspace = await this.workspace(scope, id);
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
    return workspace;
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
