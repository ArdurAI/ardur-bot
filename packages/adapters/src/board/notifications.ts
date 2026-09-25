import type { NotificationProvider } from "@ardurbot/adapter-kit";
import type { Pool, PrismaClient } from "@ardurbot/db";
import { getUserPreferences } from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";

const BOARD_NOTIFICATION_LOCK_NAMESPACE = 1_380_019_075;
const BOARD_NOTIFICATION_LOCK_ID = 3;

/** A batch has one shared deadline; an optional push service cannot extend it per row. */
export async function deliverBoardNotifications(
  prisma: PrismaClient,
  notifications: NotificationProvider,
  signal: AbortSignal = AbortSignal.timeout(15_000),
) {
  if (signal.aborted) return;
  const rows = await prisma.boardNotification.findMany({
    where: { deliveredAt: null },
    include: { follow: { include: { workspace: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  for (const row of rows) {
    if (signal.aborted) return;
    const { follow } = row;
    const { workspace } = follow;
    try {
      const [member, deployment, preferences] = await Promise.all([
        prisma.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: workspace.spaceId, userId: follow.userId } },
        }),
        prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
        getUserPreferences(prisma, follow.userId),
      ]);
      if (
        member &&
        workspace.enabled &&
        workspace.ownerUserId === follow.userId &&
        deployment?.ownerUserId === follow.userId &&
        preferences.notifications.responseCompletions
      ) {
        await notifications.send(
          {
            kind: "board",
            title: row.title.slice(0, 200),
            body: row.changes
              .map((change) =>
                change === "comment"
                  ? "New comment"
                  : change === "assignee"
                    ? "Assignee changed"
                    : "Status changed",
              )
              .join(" · "),
            botId: "",
            threadId: `board:${workspace.id}:${follow.itemId}`,
            board: { spaceId: workspace.spaceId, workspaceId: workspace.id, itemId: follow.itemId },
          },
          {
            operationId: row.id,
            traceId: row.id,
            spaceId: workspace.spaceId,
            userId: follow.userId,
            botId: "",
            signal,
          },
        );
      }
      signal.throwIfAborted();
      await prisma.boardNotification.update({
        where: { id: row.id },
        data: { deliveredAt: new Date() },
      });
    } catch (error) {
      if (signal.aborted) return;
      getLogger().error("board notification delivery", error);
      // A later reconciliation retries transport errors without affecting the item write.
    }
  }
}

/**
 * One tick holds a transaction advisory lock and then returns the client.
 * Periodic delivery does not keep a session lock for the process lifetime.
 */
async function deliverWithLock(pool: Pick<Pool, "connect">, deliver: () => Promise<void>) {
  const client = await pool.connect();
  let released = false;
  const finish = (destroy = false) => {
    if (released) return;
    released = true;
    client.release(destroy);
  };
  try {
    await client.query("BEGIN");
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS acquired",
        [BOARD_NOTIFICATION_LOCK_NAMESPACE, BOARD_NOTIFICATION_LOCK_ID],
      );
      if (result.rows[0]?.acquired === true) await deliver();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => finish(true));
      throw error;
    }
  } finally {
    finish();
  }
}

/** Push delivery has its own schedule, outside run recovery. */
export function createBoardNotificationDelivery(deps: {
  prisma: PrismaClient;
  notifications: NotificationProvider;
  pool: Pick<Pool, "connect">;
}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let stopped = true;
  const tick = () => {
    if (stopped || running) return;
    const abort = new AbortController();
    controller = abort;
    const deadline = setTimeout(() => abort.abort(), 15_000);
    running = deliverWithLock(deps.pool, () =>
      deliverBoardNotifications(deps.prisma, deps.notifications, abort.signal),
    )
      .catch((error) => getLogger().error("board notification delivery", error))
      .finally(() => {
        clearTimeout(deadline);
        running = undefined;
        controller = undefined;
      });
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      tick();
      timer = setInterval(tick, 30_000);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
      await running;
    },
  };
}
