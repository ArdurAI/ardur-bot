import { expect, it, vi } from "vitest";
import { learningSecrets } from "./learning-redaction.js";

it("collects credential values without collecting connection metadata", async () => {
  const secret = "T4h7K0m3P8q2R5s9V1x6Y3z8B4c7D2f5";
  const prisma = {
    secret: { findMany: vi.fn(async () => [{ id: "stored", ciphertext: "fixture" }]) },
    botSecret: { findMany: vi.fn(async () => []) },
  };
  const store = {
    load: vi.fn(() =>
      JSON.stringify({
        label: "reports",
        kind: "repo",
        credential: { name: "projects", value: secret },
      }),
    ),
  };
  expect(
    await learningSecrets(prisma as never, store as never, {
      spaceId: "space",
      userId: "user",
      botId: "bot",
    }),
  ).toEqual([secret]);
});
