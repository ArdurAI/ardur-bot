import { expect, it, vi } from "vitest";
import { resetBriefRetriesForConnection } from "./brief-retries.js";
import { Prisma } from "./client.js";

it("connection saves reset only that user's connected or inherited bot and group briefs", async () => {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  await resetBriefRetriesForConnection({ botBrief: { updateMany } } as never, {
    userId: "owner",
    credentialId: "connection",
    provider: "fixture",
  });
  expect(updateMany).toHaveBeenCalledWith({
    where: {
      userId: "owner",
      OR: [
        { bot: { modelCredentialId: "connection" } },
        {
          bot: {
            modelCredentialId: null,
            modelProvider: "fixture",
          },
        },
        {
          thread: {
            group: {
              members: {
                some: {
                  bot: { userId: "owner" },
                  OR: [
                    { runtimePin: { path: ["credentialId"], equals: "connection" } },
                    {
                      AND: [
                        { runtimePin: { path: ["provider"], equals: "fixture" } },
                        { runtimePin: { path: ["credentialId"], equals: Prisma.JsonNull } },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    },
    data: { failureCount: 0, nextAttemptAt: null, attemptedAt: null },
  });
});

it("does not reject the saved connection when retry cleanup fails", async () => {
  await expect(
    resetBriefRetriesForConnection(
      {
        botBrief: { updateMany: vi.fn().mockRejectedValue(new Error("reset unavailable")) },
      } as never,
      { userId: "owner", credentialId: "connection", provider: "fixture" },
    ),
  ).resolves.toBeUndefined();
});
