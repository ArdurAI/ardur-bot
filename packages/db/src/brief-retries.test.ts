import { expect, it, vi } from "vitest";
import { resetBriefRetriesForConnection } from "./brief-retries.js";

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
            OR: [{ modelProvider: "fixture" }, { modelProvider: null }],
          },
        },
        {
          thread: {
            group: {
              members: {
                some: {
                  bot: { userId: "owner" },
                  runtimePin: { path: ["credentialId"], equals: "connection" },
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
