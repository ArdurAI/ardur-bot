import type { Actor } from "@ardurbot/contracts";
import { BoardError } from "@ardurbot/contracts/board";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { createLearningService } from "./learning.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

type LearningStub = Partial<ReturnType<typeof createLearningService>>;

vi.mock("./learning.js", () => ({ createLearningService: vi.fn() }));

async function routerFixture(learningStub: LearningStub) {
  const { createLearningService: mockedCreateLearningService } = await import("./learning.js");
  vi.mocked(mockedCreateLearningService).mockReturnValue(
    learningStub as ReturnType<typeof createLearningService>,
  );
  const prisma = {} as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/ardurbot-router-learning-board-errors-test",
  } as unknown as RouterDeps;
  const actor = {
    spaceId: "space-1",
    userId: "user-1",
    email: "user@ardurbot.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const handler = new RPCHandler(createRouter(deps));
  const call = async (path: string, body: unknown) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  };
  return { call };
}

const FILING_BUSY = "Another write is in progress. Try again in a few seconds.";
const HOST_MISSING = "Open the desktop app to use this board.";
const BOT_UNREACHABLE = "This bot cannot reach this board's computer.";

for (const [action, path] of [
  ["reject", "learning/reject"],
  ["revert", "learning/revert"],
] as const) {
  it(`surfaces the board's own busy sentence when ${action} cannot take the filing lock`, async () => {
    const { call } = await routerFixture({
      [action]: vi.fn().mockRejectedValue(new BoardError({ code: "busy", message: FILING_BUSY })),
    });
    const response = await call(path, { proposalId: "proposal-1" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ code: "BAD_REQUEST", message: FILING_BUSY }),
    });
  });

  it(`surfaces the board's own host-missing sentence when ${action} cannot reach the desktop`, async () => {
    const { call } = await routerFixture({
      [action]: vi
        .fn()
        .mockRejectedValue(new BoardError({ code: "command_failed", message: HOST_MISSING })),
    });
    const response = await call(path, { proposalId: "proposal-1" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ code: "BAD_REQUEST", message: HOST_MISSING }),
    });
  });

  it(`surfaces the board's own bot-unreachable sentence when ${action} cannot open the board`, async () => {
    const { call } = await routerFixture({
      [action]: vi
        .fn()
        .mockRejectedValue(new BoardError({ code: "forbidden", message: BOT_UNREACHABLE })),
    });
    const response = await call(path, { proposalId: "proposal-1" });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ code: "FORBIDDEN", message: BOT_UNREACHABLE }),
    });
  });
}
