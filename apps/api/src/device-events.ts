import type { DeviceEventsInput } from "@ardurbot/contracts";
import type { DeviceGrant, PrismaClient, ThreadEvents } from "@ardurbot/db";
import { DeviceRequestError } from "@ardurbot/db";
import { deviceEventWindow } from "./device-event-window.js";
import { DEVICE_RECORD_UNAVAILABLE, requireDeviceRun } from "./device-runs.js";
import { shouldForwardThreadEvent } from "./thread-message-pages.js";
import { resolveThreadTarget } from "./thread-target.js";

export async function deviceRunEvents(
  deps: { prisma: PrismaClient; events: ThreadEvents; shutdown?: AbortSignal },
  grant: DeviceGrant,
  input: DeviceEventsInput,
  signal?: AbortSignal,
) {
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
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    },
  );
}
