import type { DeviceEventsInput } from "@ardurbot/contracts";
import type { DeviceGrant, PrismaClient, ThreadEvents } from "@ardurbot/db";
import { DeviceRequestError } from "@ardurbot/db";
import { deviceEventWindow } from "./device-event-window.js";
import { DEVICE_RECORD_UNAVAILABLE, requireDeviceRun } from "./device-runs.js";
import { shouldForwardThreadEvent } from "./thread-message-pages.js";
import { resolveThreadTarget } from "./thread-target.js";

export const MAX_DEVICE_EVENT_WINDOWS_PER_GRANT = 4;
export const DEVICE_EVENT_STREAM_LIMIT_MESSAGE =
  "Wait for an open event stream to finish before opening another.";

const openWindowsByGrant = new Map<string, number>();

export function getOpenDeviceEventWindows(grantId: string): number {
  return openWindowsByGrant.get(grantId) ?? 0;
}

export function resetDeviceEventWindows(): void {
  openWindowsByGrant.clear();
}

export function acquireDeviceEventWindow(grantId: string): () => void {
  const current = openWindowsByGrant.get(grantId) ?? 0;
  if (current >= MAX_DEVICE_EVENT_WINDOWS_PER_GRANT) {
    throw new DeviceRequestError(DEVICE_EVENT_STREAM_LIMIT_MESSAGE, 429, {
      code: "stream_limit",
      message: DEVICE_EVENT_STREAM_LIMIT_MESSAGE,
    });
  }
  openWindowsByGrant.set(grantId, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = openWindowsByGrant.get(grantId) ?? 1;
    if (count <= 1) {
      openWindowsByGrant.delete(grantId);
    } else {
      openWindowsByGrant.set(grantId, count - 1);
    }
  };
}

export async function deviceRunEvents(
  deps: { prisma: PrismaClient; events: ThreadEvents; shutdown?: AbortSignal },
  grant: DeviceGrant,
  input: DeviceEventsInput,
  signal?: AbortSignal,
) {
  if ((openWindowsByGrant.get(grant.id) ?? 0) >= MAX_DEVICE_EVENT_WINDOWS_PER_GRANT) {
    throw new DeviceRequestError(DEVICE_EVENT_STREAM_LIMIT_MESSAGE, 429, {
      code: "stream_limit",
      message: DEVICE_EVENT_STREAM_LIMIT_MESSAGE,
    });
  }
  const deny = () => {
    throw new DeviceRequestError(DEVICE_RECORD_UNAVAILABLE);
  };
  const authorize = async () => {
    const live = await deps.prisma.deviceGrant.findFirst({
      where: {
        id: grant.id,
        instanceId: grant.instanceId,
        userId: grant.userId,
        spaceId: grant.spaceId,
        revokedAt: null,
        kind: "device",
      },
    });
    if (!live?.scopes.includes("read")) deny();
    if (
      !(await deps.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: grant.spaceId, userId: grant.userId } },
      }))
    )
      deny();
    const run = await requireDeviceRun(deps.prisma, grant, { runId: input.runId });
    const target = await resolveThreadTarget(
      deps.prisma,
      {
        userId: grant.userId,
        spaceId: grant.spaceId,
        email: "",
        isDeploymentOwner: false,
      },
      input,
    ).catch(deny);
    if (
      run.threadId !== input.threadId ||
      target.threadId !== input.threadId ||
      (target.kind === "bot"
        ? target.botId !== run.botId
        : !target.memberBotIds.includes(run.botId))
    )
      deny();
    const thread = await deps.prisma.thread.findFirst({
      where: { id: input.threadId, spaceId: grant.spaceId, userId: grant.userId },
      select: { nextEventSeq: true },
    });
    if (!thread || input.cursor > thread.nextEventSeq) deny();
  };
  await authorize();
  const release = acquireDeviceEventWindow(grant.id);
  try {
    const peerCache = new Map<string, Promise<boolean>>();
    return new Response(
      deviceEventWindow({
        cursor: input.cursor,
        follow: (abort) => deps.events.follow(input.threadId, input.cursor, abort),
        authorize,
        visible: async (event) =>
          event.spaceId === grant.spaceId &&
          event.threadId === input.threadId &&
          event.runId === input.runId &&
          (await shouldForwardThreadEvent(deps.prisma, event, peerCache)),
        signal,
        shutdown: deps.shutdown,
        onEnd: release,
      }),
      {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      },
    );
  } catch (error) {
    release();
    throw error;
  }
}
