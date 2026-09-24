import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { nativeHostOwner } from "./native-host.js";
import { runtimeSession } from "./runtime-session.js";

const input = {
  runId: "run",
  threadId: "thread",
  userId: "owner",
  spaceId: "space",
  botId: "bot",
  computerId: "computer",
  instructions: "instructions",
  pin: {
    runtimeKind: "claude-code" as const,
    provider: "anthropic",
    modelId: "claude-opus-5",
    effort: "low",
    credentialId: "native:claude-code",
    revision: 1,
  },
};
describe("native session ownership", () => {
  it("resumes a matching binding and excludes empty run metadata", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { run: { findFirst } } as unknown as PrismaClient;
    const first = await runtimeSession(prisma, input);
    findFirst.mockResolvedValue({
      runtimeInfo: { runtimeKind: "claude-code", sessionId: "session", binding: first.binding },
    });
    expect((await runtimeSession(prisma, input)).previous?.sessionId).toBe("session");
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        userId: "owner",
        spaceId: "space",
        botId: "bot",
        threadId: "thread",
        runtimeInfo: { not: expect.anything() },
      },
    });
    for (const changed of [
      { ...input, computerId: "other" },
      { ...input, historyGeneration: 1 },
      { ...input, instructions: "new" },
      { ...input, pin: { ...input.pin, effort: "high" } },
    ])
      expect((await runtimeSession(prisma, changed)).previous).toBeUndefined();
  });
  it("never shares one OS subscription across server accounts", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "owner" }]);
    const prisma = { user: { findMany } } as unknown as PrismaClient;
    expect(await nativeHostOwner(prisma, "owner")).toBe(true);
    expect(await nativeHostOwner(prisma, "another")).toBe(false);
    findMany.mockResolvedValue([{ id: "owner" }, { id: "another" }]);
    expect(await nativeHostOwner(prisma, "owner")).toBe(false);
  });
});
