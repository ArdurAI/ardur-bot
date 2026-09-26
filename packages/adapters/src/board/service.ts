import path from "node:path";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type {
  BoardConfiguration,
  BoardCreate,
  BoardRun,
  BoardRunResult,
  BoardWorkspace,
  WorkItem,
} from "@ardurbot/contracts/board";
import { BoardDeniedError, BoardError, BoardRunResultSchema } from "@ardurbot/contracts/board";
import type { Pool } from "@ardurbot/db";
import {
  isTooManyDatabaseConnections,
  observeBoardItems,
  Prisma,
  type PrismaClient,
} from "@ardurbot/db";
import { BoardRunner } from "@ardurbot/host-runtime/board/runner";
import { getLogger } from "@ardurbot/logging";
import { createHostClient, usesHostBridge } from "../remote-host-sandbox.js";
import { BeadsBoardProvider } from "./beads.js";
import type { PendingCloseRow } from "./pending-close.js";
import {
  botDeniedCheckAt,
  closeNoticeOwner,
  notifyUnclosedBoardItem,
  pendingCloseAction,
  recordPendingCloseFailure,
  releaseChangedBoardClose,
} from "./pending-close.js";
import {
  normalizeBoardTitle,
  RUN_FILING_CAP,
  RUN_FILING_LIMIT,
  redactBoardText,
  SPACE_FILING_CAP,
  SPACE_FILING_LIMIT,
  withBotFiledLabel,
} from "./upkeep.js";

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
  /**
   * Filing locks only. Production passes the pool from createFilingLockPool so a held lock never
   * borrows from the shared Prisma pool. Without it, tests use an in-process lock.
   */
  lockPool?: Pick<Pool, "connect">;
  /** The owner's connection to the host. Only the API has one. */
  ownerRun?: (request: BoardRun, scope: BoardScope) => Promise<BoardRunResult>;
  localRun?: (request: BoardRun, scope: BoardScope) => Promise<BoardRunResult>;
};
// Namespace 1380019075 is shared: ids 1-3 are process-wide locks. Filing locks put id 4 in
// the low three bits and the space hash above them.
const FILING_LOCK_NAMESPACE = 1_380_019_075;
const FILING_LOCK_ID = 4;
const FILING_LOCK_KEY = "(hashtext($2::text) & -8) | $3::integer";
const FILING_LOCK_WAIT_MS = 15_000;
const FILING_LOCK_POLL_MS = 250;
/** Long enough to open a connection, short enough that a full lock pool skips an item at once. */
const FILING_TRY_CHECKOUT_MS = 100;
const FILING_BUSY = "Another write is in progress. Try again in a few seconds.";
const FILING_RECORD_ATTEMPTS = 3;
const FILING_RECORD_BACKOFF_MS = 25;
const HOLLOW_RESERVATION_MS = 15 * 60 * 1000;
const localFilingLocks = new Map<string, Promise<void>>();
/** Spaces whose pooled filing lock this process holds, so a nested try never waits on itself. */
const heldFilingLocks = new Set<string>();

async function withLocalFilingLock<T>(spaceId: string, work: () => Promise<T>): Promise<T> {
  const previous = localFilingLocks.get(spaceId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  localFilingLocks.set(spaceId, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (localFilingLocks.get(spaceId) === tail) localFilingLocks.delete(spaceId);
  }
}
export class BoardService {
  private sweeping = false;
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
      if (bot?.computer?.kind !== "desktop")
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
      // The host admits a bot only inside one of its runs. Board work outside a run, such as a
      // learning proposal's item or its pending close, goes through the owner's connection.
      if (!scope.botId || !scope.runId) {
        if (!this.options.ownerRun)
          throw new BoardError({ code: "forbidden", message: "Open Board from the app." });
        const owner = { ...scope, botId: undefined };
        return this.options.ownerRun(
          scope.botId ? { ...request, actor: await this.actor(owner) } : request,
          owner,
        );
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
    if (scope.botId && !boardAdmits(row, scope.botId)) throw new BoardDeniedError();
    return { ...row, ...this.present(row) };
  }
  async botBoardChoices(scope: BoardScope) {
    await this.actor(scope);
    let dispatched: string | null = null;
    if (scope.botId && scope.runId) {
      const run = await this.options.prisma.run.findFirst({
        where: {
          id: scope.runId,
          spaceId: scope.spaceId,
          userId: scope.userId,
          botId: scope.botId,
        },
        select: { boardWorkspaceId: true },
      });
      dispatched = run?.boardWorkspaceId ?? null;
    }
    const rows = await this.options.prisma.boardWorkspace.findMany({
      where: {
        spaceId: scope.spaceId,
        ownerUserId: scope.userId,
        enabled: true,
        initialized: true,
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    const admitted = rows.filter((row) => boardAdmits(row, scope.botId));
    const implicitId =
      (dispatched && rows.some((row) => row.id === dispatched) ? dispatched : null) ??
      rows.find((row) => row.isDefault)?.id ??
      rows[0]?.id ??
      null;
    return {
      admitted,
      implicitAdmitted: Boolean(implicitId && admitted.some((row) => row.id === implicitId)),
    };
  }
  async attachFilingTargets(
    scope: { spaceId: string; userId: string },
    items: Iterable<WorkItem | null | undefined>,
  ) {
    const targets = [...items].filter((item): item is WorkItem => Boolean(item?.filedBy));
    const runIds = [
      ...new Set(targets.flatMap((item) => (item.filedBy ? [item.filedBy.runId] : []))),
    ];
    if (runIds.length === 0) return;
    const rows = await this.options.prisma.$queryRaw<
      Array<{ runId: string; groupId: string | null; messageId: string | null }>
    >(Prisma.sql`
      SELECT r.id AS "runId", t."groupId" AS "groupId", (
        SELECT m.id FROM messages m
        WHERE m."runId" = r.id AND m.role = 'bot'
        ORDER BY m.seq ASC
        LIMIT 1
      ) AS "messageId"
      FROM runs r
      INNER JOIN threads t ON t.id = r."threadId"
      WHERE r."spaceId" = ${scope.spaceId}
        AND r."userId" = ${scope.userId}
        AND r.id IN (${Prisma.join(runIds)})
    `);
    const byRun = new Map(rows.map((row) => [row.runId, row]));
    for (const item of targets) {
      const filing = item.filedBy;
      if (!filing) continue;
      const row = byRun.get(filing.runId);
      item.filedBy = {
        ...filing,
        groupId: row?.groupId ?? null,
        messageId: row?.messageId ?? null,
      };
    }
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
      observe: async (items) => {
        await observeBoardItems(this.options.prisma, workspace.id, items).catch((error) => {
          // A notification failure cannot turn a successful Beads write into a failed item edit.
          getLogger().error("board follow observation", error);
        });
        await this.sweepPendingCloses({ workspaceId: workspace.id, signal: scope.signal }).catch(
          (error) => {
            getLogger().error("pending board close", error);
          },
        );
      },
    });
  }
  /**
   * Closes filings whose Reject or Undo already committed. No database transaction is open
   * here: each item holds its space's filing lock around the host show and close, a space
   * another write holds is left for the next sweep, and the signal stops the sweep.
   * A nested board read does not start another sweep. With the host bridge on, only the API
   * can reach the host outside a run; elsewhere the sweep leaves every close for it.
   */
  async sweepPendingCloses(options: { workspaceId?: string; signal?: AbortSignal } = {}) {
    if (this.sweeping) return;
    if (usesHostBridge() && !this.options.ownerRun) {
      getLogger().debug("pending board close", {
        reason: "This process has no owner connection to the host. The app finishes the close.",
      });
      return;
    }
    this.sweeping = true;
    try {
      const now = new Date();
      const filings = await this.options.prisma.botBoardFiling.findMany({
        where: {
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
          closePending: { not: null },
          itemId: { not: null },
          OR: [{ closeNextAt: null }, { closeNextAt: { lte: now } }],
        },
      });
      for (const listed of filings) {
        if (options.signal?.aborted) return;
        if (!listed.closePending || !listed.itemId || !listed.workspaceId) continue;
        const attempt: { filing?: PendingCloseRow } = {};
        try {
          await this.withFilingLock(
            { spaceId: listed.spaceId, signal: options.signal },
            async () => {
              // Another sweep may have finished or counted this close since the list was read.
              const filing = await this.options.prisma.botBoardFiling.findUnique({
                where: { id: listed.id },
              });
              if (filing?.closePending !== listed.closePending) return;
              if (filing.closeNextAt && filing.closeNextAt > now) return;
              attempt.filing = filing;
              await this.finishPendingClose(filing, options.signal);
            },
            { waitMs: 0 },
          );
        } catch (error) {
          if (!attempt.filing) {
            if (!isFilingBusy(error) && !options.signal?.aborted)
              getLogger().error("pending board close", error);
            continue;
          }
          getLogger().error("pending board close", error);
          const failed = attempt.filing;
          await recordPendingCloseFailure(this.options.prisma, failed, (itemId) =>
            this.showPendingCloseItem(failed, itemId, options.signal),
          ).catch((recordError) => {
            getLogger().error("pending board close retry", recordError);
          });
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
  async notePendingCloseFailure(filingId: string) {
    const filing = await this.options.prisma.botBoardFiling.findUnique({
      where: { id: filingId },
    });
    if (!filing?.closePending || !filing.itemId) return;
    await recordPendingCloseFailure(this.options.prisma, filing, (itemId) =>
      this.showPendingCloseItem(filing, itemId),
    );
  }
  /** The filing's bot, as a run's outcome delivery uses the run's bot, for its owner. */
  private async pendingCloseScope(
    filing: PendingCloseRow,
    signal?: AbortSignal,
    options: { withBot?: boolean } = {},
  ) {
    if (!filing.workspaceId) throw new Error("This board close has no board.");
    const userId = await closeNoticeOwner(this.options.prisma, filing);
    if (!userId) throw new Error("This board close has no owner.");
    return {
      scope: {
        userId,
        spaceId: filing.spaceId,
        ...((options.withBot ?? true) && filing.botId ? { botId: filing.botId } : {}),
        signal,
      },
      workspaceId: filing.workspaceId,
    };
  }
  private async showPendingCloseItem(
    filing: PendingCloseRow,
    itemId: string,
    signal?: AbortSignal,
  ) {
    const { scope, workspaceId } = await this.pendingCloseScope(filing, signal);
    return (await this.provider(scope, workspaceId)).show(itemId);
  }
  private async finishPendingClose(filing: PendingCloseRow, signal?: AbortSignal) {
    const itemId = filing.itemId;
    if (!filing.closePending || !itemId || !filing.workspaceId) return;
    const { scope, workspaceId } = await this.pendingCloseScope(filing, signal);
    try {
      await this.finishClose(scope, filing, workspaceId);
    } catch (error) {
      if (!filing.botId || !(error instanceof BoardError) || error.problem.code !== "forbidden")
        throw error;
      await this.finishBotDeniedClose(filing, itemId, workspaceId, signal);
    }
  }
  /**
   * The filing's bot can no longer open the board at all (archived, moved, or no longer
   * allowed on it), so its own scope cannot see whether the item closed. The owner can open
   * their own board, so a read through the owner's scope decides instead: closed, for any
   * reason, ends the pending close exactly as a normal close would. Otherwise the close is
   * checked again in a day, and the owner is told once to close it on the Board. That next
   * check tries the bot first, so a bot that can use the board again closes it normally.
   */
  private async finishBotDeniedClose(
    filing: PendingCloseRow,
    itemId: string,
    workspaceId: string,
    signal?: AbortSignal,
  ) {
    const owner = await this.pendingCloseScope(filing, signal, { withBot: false });
    const item = await this.provider(owner.scope, workspaceId)
      .then((provider) => provider.show(itemId))
      .catch((error: unknown) => {
        // The owner's board is out of reach too; the daily check reads it again.
        getLogger().error("pending board close", error);
        return null;
      });
    if (item?.status === "closed") {
      await this.options.prisma.botBoardFiling.deleteMany({
        where: { id: filing.id, spaceId: filing.spaceId },
      });
      return;
    }
    const denied = { ...filing, closeDeniedAt: filing.closeDeniedAt ?? new Date() };
    const marked = await this.options.prisma.botBoardFiling.updateMany({
      where: { id: filing.id, closePending: filing.closePending },
      data: { closeDeniedAt: denied.closeDeniedAt, closeNextAt: botDeniedCheckAt() },
    });
    if (marked.count !== 1 || filing.closeNoticeAt) return;
    await notifyUnclosedBoardItem(this.options.prisma, denied, async () => item, "close-denied");
  }
  /**
   * Shows the item, decides whether it can close, and closes or releases it, then deletes the
   * filing row. Shared by the sweep, and by Reject and Undo retrying a close that already
   * committed. The caller resolves the scope: the sweep opens the board as the owner, through
   * the filing's bot; a retry opens it as the clicking person, with their own board access.
   */
  async finishClose(
    scope: BoardScope,
    filing: PendingCloseRow,
    workspaceId = filing.workspaceId ?? undefined,
  ): Promise<"close" | "done" | "changed"> {
    if (!filing.closePending || !filing.itemId || !workspaceId) return "done";
    const provider = await this.provider(scope, workspaceId);
    const item = await provider.show(filing.itemId);
    const action = pendingCloseAction(item, {
      closePending: filing.closePending,
      closeUpdatedAt: filing.closeUpdatedAt,
      closeCommentCount: filing.closeCommentCount,
    });
    if (action === "changed") {
      await releaseChangedBoardClose(this.options.prisma, filing);
      return action;
    }
    if (action === "close") await provider.close([item.id], filing.closePending);
    await this.options.prisma.botBoardFiling.deleteMany({
      where: { id: filing.id, spaceId: filing.spaceId },
    });
    return action;
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
  async upkeep(scope: BoardScope) {
    await this.actor(scope);
    const row = await this.options.prisma.space.findUnique({
      where: { id: scope.spaceId },
      select: { botUpkeep: true },
    });
    return { enabled: row?.botUpkeep !== false };
  }
  async setUpkeep(scope: BoardScope, enabled: boolean) {
    if (scope.botId)
      throw new BoardError({ code: "forbidden", message: "Configure this board in Settings." });
    await this.actor(scope);
    const saved = await this.options.prisma.space.update({
      where: { id: scope.spaceId },
      data: { botUpkeep: enabled },
      select: { botUpkeep: true },
    });
    return { enabled: saved.botUpkeep };
  }
  /**
   * Serializes a space's title check, reservation, host create and metadata. Host commands
   * can outlast any database transaction, so the lock is a session advisory lock on one
   * pooled connection. Waiters poll without holding a connection and give up after a bound;
   * `waitMs: 0` tries once.
   */
  async withFilingLock<T>(
    scope: Pick<BoardScope, "spaceId" | "signal">,
    work: () => Promise<T>,
    { waitMs = FILING_LOCK_WAIT_MS }: { waitMs?: number } = {},
  ): Promise<T> {
    const busy = () => new BoardError({ code: "busy", message: FILING_BUSY });
    const pool = this.options.lockPool;
    if (!pool) {
      // The in-process lock does not exclude another process, so it is for tests only.
      if (process.env.NODE_ENV === "production")
        throw new Error("Board filings need the filing lock pool.");
      if (waitMs === 0 && localFilingLocks.has(scope.spaceId)) throw busy();
      return withLocalFilingLock(scope.spaceId, work);
    }
    if (waitMs === 0 && heldFilingLocks.has(scope.spaceId)) throw busy();
    const key = [FILING_LOCK_NAMESPACE, scope.spaceId, FILING_LOCK_ID];
    const deadline = Date.now() + waitMs;
    for (;;) {
      scope.signal?.throwIfAborted();
      // A try, such as a board read's sweep, waits almost no time for a connection.
      const connected = await checkout(
        pool,
        Math.max(FILING_TRY_CHECKOUT_MS, deadline - Date.now()),
      ).then(
        (client) =>
          client ? { ok: true as const, client } : { ok: false as const, error: undefined },
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (connected.ok) {
        const client = connected.client;
        let locked = false;
        let lost = false;
        try {
          locked =
            (
              await client.query<{ acquired: boolean }>(
                `SELECT pg_try_advisory_lock($1::integer, ${FILING_LOCK_KEY}) AS acquired`,
                key,
              )
            ).rows[0]?.acquired === true;
          if (locked) {
            heldFilingLocks.add(scope.spaceId);
            return await work();
          }
        } finally {
          if (locked) {
            heldFilingLocks.delete(scope.spaceId);
            await client
              .query(`SELECT pg_advisory_unlock($1::integer, ${FILING_LOCK_KEY})`, key)
              .catch(() => {
                lost = true;
              });
          }
          // A connection that could not unlock still holds the lock until it closes.
          client.release(lost);
        }
      } else if (connected.error !== undefined && !isFilingPoolBusy(connected.error))
        throw connected.error;
      // Waiting does not need a free connection. A full lock pool or a full Postgres server
      // refuses the checkout; that is still "busy" until the deadline.
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw busy();
      await new Promise((resolve) => setTimeout(resolve, Math.min(FILING_LOCK_POLL_MS, remaining)));
    }
  }
  /** Checks the caps and inserts the reservation in one short transaction. */
  async reserveBotFiling(scope: BoardScope, titleKey: string) {
    const runId = scope.runId;
    if (!runId) return { ok: false as const, message: RUN_FILING_LIMIT };
    return this.options.prisma.$transaction(async (tx) => {
      const runCount = await tx.botBoardFiling.count({
        where: { spaceId: scope.spaceId, runId, ...countedFilingWhere() },
      });
      if (runCount >= RUN_FILING_CAP) return { ok: false as const, message: RUN_FILING_LIMIT };
      if (await this.spaceFilingCapReached(tx, scope.spaceId))
        return { ok: false as const, message: SPACE_FILING_LIMIT };
      const row = await tx.botBoardFiling.create({
        data: { spaceId: scope.spaceId, runId, botId: scope.botId ?? null, titleKey },
      });
      return { ok: true as const, id: row.id };
    });
  }
  async recordFilingItem(filingId: string, workspaceId: string, itemId: string) {
    let last: unknown;
    for (let attempt = 0; attempt < FILING_RECORD_ATTEMPTS; attempt += 1) {
      try {
        await this.options.prisma.botBoardFiling.update({
          where: { id: filingId },
          data: { workspaceId, itemId },
        });
        return;
      } catch (error) {
        last = error;
        if (attempt === FILING_RECORD_ATTEMPTS - 1) break;
        await new Promise((resolve) =>
          setTimeout(resolve, FILING_RECORD_BACKOFF_MS * (attempt + 1)),
        );
      }
    }
    throw last;
  }
  /**
   * Keeps a reservation whose item exists, whatever the error type. Deletes it only when
   * no item id is known. Recording retries before this gives up and leaves the row.
   */
  async settleFailedFiling(
    filingId: string,
    workspaceId: string,
    error: unknown,
    createdItemId?: string,
  ) {
    const itemId =
      createdItemId ?? (error instanceof BoardError ? error.problem.itemId : undefined);
    try {
      if (itemId) await this.recordFilingItem(filingId, workspaceId, itemId);
      else await this.options.prisma.botBoardFiling.delete({ where: { id: filingId } });
    } catch (settleError) {
      getLogger().error("board filing cleanup", settleError);
    }
  }
  /**
   * This run's fresh reservation for the same normalized title, when it never received an item id.
   * Claims only an open item with no filer, no filing row, and a created time from the
   * reservation's second through the next 15 minutes. A reservation older than 15 minutes
   * is deleted. That delete permits a new item only when no open item has the title.
   */
  async claimHollowFiling(
    scope: BoardScope,
    workspaceId: string,
    item: Pick<WorkItem, "id" | "createdAt" | "filedBy">,
    titleKey: string,
  ) {
    if (!scope.runId || item.filedBy) return null;
    const hollow = await this.options.prisma.botBoardFiling.findFirst({
      where: { spaceId: scope.spaceId, runId: scope.runId, itemId: null, titleKey },
      orderBy: { createdAt: "desc" },
    });
    if (!hollow?.createdAt || !createdWithinReservation(item.createdAt, hollow.createdAt))
      return null;
    const taken = await this.options.prisma.botBoardFiling.findFirst({
      where: { workspaceId, itemId: item.id },
    });
    if (taken) return null;
    await this.recordFilingItem(hollow.id, workspaceId, item.id);
    return hollow;
  }
  /** Deletes this run's hollow reservation once it is older than 15 minutes. */
  async discardStaleHollow(scope: BoardScope, titleKey: string) {
    if (!scope.runId) return false;
    const hollow = await this.options.prisma.botBoardFiling.findFirst({
      where: { spaceId: scope.spaceId, runId: scope.runId, itemId: null, titleKey },
      orderBy: { createdAt: "desc" },
    });
    if (!hollow?.createdAt || !reservationIsStale(hollow.createdAt)) return false;
    await this.options.prisma.botBoardFiling.delete({ where: { id: hollow.id } });
    return true;
  }
  /** The run's own filing for an item, when an earlier attempt created it. */
  async runFiling(scope: BoardScope, workspaceId: string, itemId: string) {
    if (!scope.runId) return null;
    return this.options.prisma.botBoardFiling.findFirst({
      where: { spaceId: scope.spaceId, runId: scope.runId, workspaceId, itemId },
    });
  }
  private async spaceFilingCapReached(tx: Prisma.TransactionClient, spaceId: string) {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const freshHollow = new Date(Date.now() - HOLLOW_RESERVATION_MS);
    const count = await tx.botBoardFiling.count({
      where: {
        spaceId,
        reused: false,
        createdAt: { gte: since },
        OR: [{ itemId: { not: null } }, { createdAt: { gte: freshHollow } }],
      },
    });
    return count >= SPACE_FILING_CAP;
  }
  /** Call inside withFilingLock. A retry returns the item this proposal already filed or reused. */
  async fileLearningProposal(
    scope: BoardScope & { botId: string },
    proposalId: string,
    input: Pick<BoardCreate, "title" | "description" | "acceptanceCriteria" | "labels"> & {
      workspaceId?: string;
    },
    secrets: string[],
  ) {
    const prisma = this.options.prisma;
    const own = await prisma.botBoardFiling.findFirst({
      where: { spaceId: scope.spaceId, learningProposalId: proposalId },
    });
    if (own?.workspaceId && own.itemId) {
      const provider = await this.provider(scope, own.workspaceId);
      return {
        item: await provider.show(own.itemId),
        duplicate: own.reused === true,
        workspaceId: own.workspaceId,
      };
    }
    const workspace = await this.workspace(scope, input.workspaceId);
    const provider = await this.provider(scope, workspace.id);
    const item = {
      title: redactBoardText(input.title, secrets),
      description: redactBoardText(input.description ?? "", secrets),
      acceptanceCriteria: redactBoardText(input.acceptanceCriteria ?? "", secrets),
    };
    const title = normalizeBoardTitle(item.title);
    const existing = (await provider.list()).find(
      (row) => row.status !== "closed" && normalizeBoardTitle(row.title) === title,
    );
    const stale = Boolean(own && !own.itemId && own.createdAt && reservationIsStale(own.createdAt));
    if (
      !stale &&
      own &&
      !own.itemId &&
      own.titleKey === title &&
      own.createdAt &&
      existing &&
      !existing.filedBy
    ) {
      const taken = await prisma.botBoardFiling.findFirst({
        where: { workspaceId: workspace.id, itemId: existing.id },
      });
      if (!taken && createdWithinReservation(existing.createdAt, own.createdAt)) {
        await this.recordFilingItem(own.id, workspace.id, existing.id);
        return { item: existing, duplicate: false, workspaceId: workspace.id };
      }
    }
    if (own && !own.itemId) await prisma.botBoardFiling.delete({ where: { id: own.id } });
    const link = {
      spaceId: scope.spaceId,
      runId: null,
      botId: scope.botId,
      workspaceId: workspace.id,
      learningProposalId: proposalId,
      titleKey: title,
      reused: false,
    };
    if (existing) {
      await prisma.botBoardFiling.create({
        data: { ...link, itemId: existing.id, reused: true },
      });
      return { item: existing, duplicate: true, workspaceId: workspace.id };
    }
    const filing = await prisma.$transaction(async (tx) => {
      if (await this.spaceFilingCapReached(tx, scope.spaceId))
        throw new BoardError({ code: "busy", message: SPACE_FILING_LIMIT });
      return tx.botBoardFiling.create({ data: link });
    });
    let createdId: string | undefined;
    try {
      const created = await provider.create({
        ...item,
        type: "task",
        priority: 2,
        labels: withBotFiledLabel(input.labels?.map((label) => redactBoardText(label, secrets))),
      });
      createdId = created.id;
      await this.recordFilingItem(filing.id, workspace.id, created.id);
      return { item: created, duplicate: false, workspaceId: workspace.id };
    } catch (error) {
      await this.settleFailedFiling(filing.id, workspace.id, error, createdId);
      throw error;
    }
  }
  async filingOutcomes(scope: BoardScope) {
    await this.actor(scope);
    const since = new Date(Date.now() - 30 * 86400_000);
    const rows = await this.options.prisma.$queryRaw<
      Array<{
        botId: string;
        name: string;
        filed: bigint;
        done: bigint;
        open: bigint;
        other: bigint;
      }>
    >(Prisma.sql`
      SELECT f."botId" AS "botId", COALESCE(b.name, 'Bot') AS name,
        COUNT(*) AS filed,
        COUNT(*) FILTER (WHERE f.outcome = 'completed') AS done,
        COUNT(*) FILTER (WHERE f.outcome IS NULL) AS open,
        COUNT(*) FILTER (WHERE f.outcome = 'closed-other') AS other
      FROM bot_board_filings f
      LEFT JOIN bots b ON b.id = f."botId" AND b."spaceId" = f."spaceId"
      WHERE f."spaceId" = ${scope.spaceId}
        AND f."botId" IS NOT NULL
        AND f."itemId" IS NOT NULL
        AND NOT f.reused
        AND f."createdAt" >= ${since}
      GROUP BY f."botId", b.name
      ORDER BY COALESCE(b.name, 'Bot'), f."botId"
    `);
    return {
      bots: rows.map((row) => ({
        botId: row.botId,
        name: row.name,
        filed: Number(row.filed),
        done: Number(row.done),
        open: Number(row.open),
        other: Number(row.other),
      })),
    };
  }
}

/** Resolves null when no connection arrives in time. A late one goes straight back to the pool. */
async function checkout(pool: Pick<Pool, "connect">, timeoutMs: number) {
  const pending = pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const client = await Promise.race([pending, late]);
    if (!client)
      void pending.then(
        (arrived) => arrived.release(),
        () => undefined,
      );
    return client;
  } finally {
    clearTimeout(timer);
  }
}

function isFilingPoolBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("timeout exceeded when trying to connect") ||
    isTooManyDatabaseConnections(error)
  );
}

function isFilingBusy(error: unknown): boolean {
  return error instanceof BoardError && error.problem.code === "busy";
}

/**
 * Beads lists created_at as a whole second. A reservation stores milliseconds.
 * An item counts when its created time, at whole-second precision, is at or after
 * the reservation's second and at or before the reservation plus 15 minutes, and
 * the reservation itself is still inside those 15 minutes. A human item created
 * in that same second, with no filer and no filing row, is claimed; that is accepted.
 */
function createdWithinReservation(itemCreatedAt: string, reservedAt: Date): boolean {
  const created = new Date(itemCreatedAt).getTime();
  const reserved = reservedAt.getTime();
  if (Number.isNaN(created) || Number.isNaN(reserved) || reservationIsStale(reservedAt))
    return false;
  return (
    Math.floor(created / 1000) >= Math.floor(reserved / 1000) &&
    created <= reserved + HOLLOW_RESERVATION_MS
  );
}

/** A hollow reservation older than 15 minutes is never claimed. */
function reservationIsStale(reservedAt: Date, now = Date.now()): boolean {
  const reserved = reservedAt.getTime();
  return !Number.isNaN(reserved) && reserved < now - HOLLOW_RESERVATION_MS;
}

/** A hollow reservation counts only for its first 15 minutes. An attached item always counts. */
function countedFilingWhere() {
  const freshHollow = new Date(Date.now() - HOLLOW_RESERVATION_MS);
  return {
    OR: [{ itemId: { not: null } }, { itemId: null, createdAt: { gte: freshHollow } }],
  };
}

function boardAdmits(row: { allowAllBots: boolean; allowedBotIds: string[] }, botId?: string) {
  return !botId || row.allowAllBots || row.allowedBotIds.includes(botId);
}
