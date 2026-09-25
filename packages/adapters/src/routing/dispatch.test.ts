import type { DeviceGrant, PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { admitRoutedDispatch } from "./dispatch.js";

vi.mock("@ardurbot/db", async (original) => ({
  ...(await original<object>()),
  admitDispatch: async (
    tx: unknown,
    grant: DeviceGrant,
    _input: unknown,
    _origin: unknown,
    route: (tx: unknown, defaults: { defaultBotId: string | null }) => Promise<unknown>,
  ) => route(tx, { defaultBotId: grant.defaultBotId }),
}));

describe("sender activity routing", () => {
  it.each(["chief", null])(
    "follows the latest eligible bot with default %s",
    async (defaultBotId) => {
      const grant = {
        id: "sender",
        spaceId: "space",
        userId: "owner",
        defaultBotId,
      } as DeviceGrant;
      const bots = ["chief", "worker"].map((id) => ({
        id,
        name: id,
        thread: { id: `thread-${id}` },
      }));
      // Newest first: an ineligible bot and another sender must not mask this sender's worker.
      const runs = [
        { botId: "removed", originDeviceGrantId: "sender" },
        { botId: "chief", originDeviceGrantId: "other-sender" },
        { botId: "worker", originDeviceGrantId: "sender" },
        { botId: "chief", originDeviceGrantId: "sender" },
      ].map((run) => ({ ...run, spaceId: "space", userId: "owner" }));
      const findFirst = vi.fn(
        async ({
          where,
        }: {
          where: {
            botId: string | { in: string[] };
            spaceId: string;
            userId: string;
            originDeviceGrantId: string;
          };
        }) =>
          runs.find(
            (run) =>
              (typeof where.botId === "string"
                ? run.botId === where.botId
                : where.botId.in.includes(run.botId)) &&
              run.spaceId === where.spaceId &&
              run.userId === where.userId &&
              run.originDeviceGrantId === where.originDeviceGrantId,
          ) ?? null,
      );
      const prisma = {
        bot: { findMany: vi.fn(async () => bots) },
        space: { findUnique: vi.fn(async () => ({ coordinatorBotId: "chief" })) },
        run: { findFirst },
      } as unknown as PrismaClient;
      expect(
        await admitRoutedDispatch(prisma, grant, {
          text: "Continue",
          clientNonce: "follow-up-nonce",
        }),
      ).toMatchObject({
        botId: "worker",
        threadId: "thread-worker",
        rule: "last-active-thread",
        routedByDefault: false,
      });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: "desc" } }),
      );
    },
  );
});
