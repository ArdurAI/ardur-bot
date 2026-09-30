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
    email: "user@example.test",
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

  it(`surfaces FORBIDDEN, not BAD_REQUEST, when ${action} finds the person's own board access is gone`, async () => {
    const { call } = await routerFixture({
      [action]: vi.fn().mockRejectedValue(
        new BoardError({
          code: "access_lost",
          message: "This board is only available to this computer's owner.",
        }),
      ),
    });
    const response = await call(path, { proposalId: "proposal-1" });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "FORBIDDEN",
        message: "This board is only available to this computer's owner.",
      }),
    });
  });
}

it("sends only a generic code for an error it has no sentence for, so screens show their own", async () => {
  const { call } = await routerFixture({
    reject: vi.fn().mockRejectedValue(new Error("This suggestion is no longer pending.")),
  });
  const response = await call("learning/reject", { proposalId: "proposal-1" });
  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toEqual({
    json: expect.objectContaining({
      defined: false,
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
    }),
  });
});

vi.mock("./model-pin-validation.js", () => ({
  validateModelPinSelection: vi.fn(),
}));

it("accepts and validates a Codex runtime reviewer", async () => {
  const { validateModelPinSelection: mockedValidate } = await import("./model-pin-validation.js");
  vi.mocked(mockedValidate).mockResolvedValue({
    runtimeKind: "codex-app-server",
    provider: "openai-codex",
    modelId: "fake-model",
    credentialId: "native:codex-app-server",
    effort: "high",
    revision: 1,
  });

  const setReviewer = vi.fn().mockResolvedValue({
    enabled: true,
    consolidationEnabled: false,
    insightsEnabled: true,
    reviewerPin: null,
    budgets: {
      botDailyTokens: 30000,
      spaceDailyTokens: 150000,
      maxProposals: 3,
      timeoutMs: 30000,
      maxOutputTokens: 2000,
      maxOutputChars: 12000,
    },
    destination: null,
    canConfigure: true,
  });
  const { call } = await routerFixture({ setReviewer });

  const pin = {
    runtimeKind: "codex-app-server",
    provider: "openai-codex",
    modelId: "fake-model",
    credentialId: "native:codex-app-server",
    effort: "high",
  };
  const response = await call("learning/setReviewer", { expectedRevision: 0, pin });

  expect(response.status).toBe(200);
  expect(mockedValidate).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    pin,
  );
  expect(setReviewer).toHaveBeenCalledWith(expect.anything(), {
    expectedRevision: 0,
    pin: expect.objectContaining({ runtimeKind: "codex-app-server", revision: 1 }),
  });
});

it("rejects another user's connection with a sentence", async () => {
  const { validateModelPinSelection: mockedValidate } = await import("./model-pin-validation.js");
  const { ORPCError } = await import("@orpc/server");
  vi.mocked(mockedValidate).mockRejectedValue(
    new ORPCError("FORBIDDEN", { message: "This connection belongs to another space member." }),
  );

  const { call } = await routerFixture({
    setReviewer: vi.fn(),
  });

  const response = await call("learning/setReviewer", {
    expectedRevision: 0,
    pin: {
      runtimeKind: "pi",
      provider: "fake",
      modelId: "fake-model",
      credentialId: "cred-1",
      effort: null,
    },
  });

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    json: expect.objectContaining({
      code: "FORBIDDEN",
      message: "This connection belongs to another space member.",
    }),
  });
});
