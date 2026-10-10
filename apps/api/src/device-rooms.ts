import type { DeviceRoomSendInput } from "@ardurbot/contracts";
import { ThreadSendResultSchema } from "@ardurbot/contracts";
import type { DeviceGrant } from "@ardurbot/db";
import { DeviceRequestError, requireMembership } from "@ardurbot/db";
import { DeviceRoomContext } from "./device-room-context.js";
import { DEVICE_RECORD_UNAVAILABLE } from "./device-runs.js";
import type { RemoteDevicesDeps } from "./remote-devices.js";
import { resolveThreadTarget, sendThreadMessage } from "./thread-target.js";

export async function sendDeviceRoom(
  deps: RemoteDevicesDeps,
  grant: DeviceGrant,
  input: DeviceRoomSendInput,
) {
  const actor = await requireMembership(deps.prisma, grant.userId, grant.spaceId);
  const device = new DeviceRoomContext(grant);
  await deps.prisma.$transaction((tx) => device.verify(tx, actor));
  let groupId = input.groupId;
  if (input.roomName) {
    const matches = await deps.prisma.chatGroup.findMany({
      where: {
        spaceId: grant.spaceId,
        userId: grant.userId,
        archivedAt: null,
        name: { equals: input.roomName, mode: "insensitive" },
      },
      select: { id: true },
      take: 2,
    });
    if (matches.length !== 1) throw new DeviceRequestError(DEVICE_RECORD_UNAVAILABLE, 400);
    groupId = matches[0]!.id;
  }
  const target = await resolveThreadTarget(deps.prisma, actor, { groupId });
  if (target.kind !== "group" || (input.threadId && input.threadId !== target.threadId))
    throw new DeviceRequestError(DEVICE_RECORD_UNAVAILABLE);
  const result = await sendThreadMessage(
    deps,
    actor,
    target,
    {
      text: input.text,
      clientNonce: `device-room:${grant.id}:${input.clientNonce}`,
    },
    device,
  );
  // A revoke or owner change during publication must refuse the response too.
  await deps.prisma.$transaction((tx) => device.verify(tx, actor));
  return ThreadSendResultSchema.parse(result);
}
