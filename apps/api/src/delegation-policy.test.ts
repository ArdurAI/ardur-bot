import type { Actor, LocalityPolicy } from "@ardurbot/contracts";
import { failureCategoryMessage } from "@ardurbot/contracts";
import { IsolationError } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = { userId: "admin", spaceId: "space" } as Actor;
function fixture({
  inherited = false,
  baseUrl = "https://models.example.com/v1",
  role = "admin",
  provider = "openai-compatible",
} = {}) {
  const bots = ["Alpha", "Beta"].map((name, index) => ({
    id: `bot-${index}`,
    name,
    userId: `owner-${index}`,
    spaceId: "space",
    runtimeKind: provider === "openai" ? "codex-app-server" : "pi",
    modelProvider: inherited ? null : provider,
    modelId: inherited ? null : "fixture-model",
    modelCredentialId: inherited
      ? null
      : provider === "openai"
        ? "native:codex-app-server"
        : `connection-${index}`,
    thinkingLevel: "off",
    modelPinRevision: 1,
    groupMembers: [] as { runtimePin: unknown }[],
  }));
  const credentials = bots.map((bot, index) => ({
    id: `connection-${index}`,
    userId: bot.userId,
    provider,
    secretId: `secret-${index}`,
    label: "Fixture",
    defaultModel: "fixture-model",
    isDefault: true,
  }));
  const prisma = {
    bot: {
      findMany: vi.fn(async () => bots),
      findFirstOrThrow: vi.fn(async ({ where }) => {
        const bot = bots.find(
          (row) =>
            row.id === where.id && row.userId === where.userId && row.spaceId === where.spaceId,
        );
        if (!bot) throw new IsolationError();
        return bot;
      }),
      update: vi.fn(),
    },
    space: { update: vi.fn() },
    spaceMember: { findUnique: vi.fn(async () => ({ role })) },
    userModelCredential: {
      findFirst: vi.fn(
        async ({ where }) =>
          credentials.find(
            (row) =>
              row.id === where.id && row.userId === where.userId && row.provider === where.provider,
          ) ?? null,
      ),
    },
    spaceModelPreference: {
      findFirst: vi.fn(async ({ where }) => {
        const credential = credentials.find((row) => row.userId === where.userId);
        return credential ? { credential, modelId: "fixture-model", isDefault: true } : null;
      }),
    },
    secret: {
      findFirst: vi.fn(async ({ where }) => {
        const credential = credentials.find(
          (row) => row.secretId === where.id && row.userId === where.userId,
        );
        return credential ? { id: credential.secretId, ciphertext: "fixture" } : null;
      }),
    },
  };
  const deps = {
    env: { webOrigin: "http://localhost" },
    prisma,
    secrets: {
      load: () =>
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl,
          reasoning: false,
          thinkingLevel: "off",
        }),
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(policy: LocalityPolicy, caller = actor, botId?: string) {
    const { response } = await handler.handle(
      new Request("http://localhost/rpc/delegations/setPolicy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId, policy } }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    return { status: response!.status, body: await response!.json() };
  }
  return { prisma, call, bots };
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  {
    inherited: false,
    baseUrl: "https://models.example.com/v1",
    policy: { mode: "local" },
    allowed: false,
  },
  {
    inherited: true,
    baseUrl: "https://models.example.com/v1",
    policy: { mode: "local" },
    allowed: false,
  },
  {
    inherited: false,
    baseUrl: "http://localhost:11434/v1",
    policy: { mode: "local" },
    allowed: true,
  },
  {
    inherited: true,
    baseUrl: "http://localhost:11434/v1",
    policy: { mode: "local" },
    allowed: true,
  },
  {
    inherited: false,
    baseUrl: "https://models.example.com/v1",
    policy: { mode: "hosts", hosts: ["models.example.com"] },
    allowed: true,
  },
  {
    inherited: true,
    baseUrl: "https://models.example.com/v1",
    policy: { mode: "hosts", hosts: ["other.example.com"] },
    allowed: false,
  },
  {
    inherited: false,
    baseUrl: "https://models.example.com/v1",
    policy: { mode: "any" },
    allowed: true,
  },
] as const)(
  "space policy checks saved/inherited destination: $policy / $inherited / $allowed",
  async (row) => {
    const f = fixture(row);
    const result = await f.call(row.policy as LocalityPolicy);
    expect(result.status).toBe(row.allowed ? 200 : 400);
    expect(f.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space", archivedAt: null },
      }),
    );
    if (row.allowed) expect(f.prisma.space.update).toHaveBeenCalledOnce();
    else {
      expect(f.prisma.space.update).not.toHaveBeenCalled();
      expect(result.body).toMatchObject({
        json: {
          message: failureCategoryMessage("destinations-space"),
          data: {
            blockedBots: [
              { id: "bot-0", name: "Alpha" },
              { id: "bot-1", name: "Beta" },
            ],
          },
        },
      });
    }
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
    expect(f.prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret-0", userId: "owner-0", spaceId: null },
    });
  },
);

it.each([false, true])(
  "bot locality policy checks its %s inherited pin before writing",
  async (inherited) => {
    const f = fixture({ inherited });
    const result = await f.call({ mode: "local" }, { ...actor, userId: "owner-0" }, "bot-0");
    expect(result).toMatchObject({
      status: 400,
      body: {
        json: {
          message: failureCategoryMessage("destinations-bot", { bot: "this bot" }),
        },
      },
    });
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
    expect(f.prisma.spaceMember.findUnique).not.toHaveBeenCalled();
  },
);

it("native remote pins cannot be made local-only", async () => {
  const f = fixture({ provider: "openai" });
  expect((await f.call({ mode: "local" })).status).toBe(400);
  expect(f.prisma.space.update).not.toHaveBeenCalled();
});

it("an offline local Ollama pin needs no network probe for a locality save", async () => {
  const f = fixture({ provider: "ollama", baseUrl: "http://localhost:11434/v1" });
  const fetch = vi.fn(() => {
    throw new Error("must not probe");
  });
  vi.stubGlobal("fetch", fetch);
  expect((await f.call({ mode: "local" })).status).toBe(200);
  expect(fetch).not.toHaveBeenCalled();
});

it("space policy authorization happens before reading bots or connections", async () => {
  const f = fixture({ role: "member" });
  expect((await f.call({ mode: "local" })).status).toBe(403);
  expect(f.prisma.bot.findMany).not.toHaveBeenCalled();
  expect(f.prisma.secret.findFirst).not.toHaveBeenCalled();
  expect(f.prisma.space.update).not.toHaveBeenCalled();
});

it("a bot policy cannot target another owner's bot", async () => {
  const f = fixture();
  expect((await f.call({ mode: "any" }, actor, "bot-0")).status).not.toBe(200);
  expect(f.prisma.secret.findFirst).not.toHaveBeenCalled();
  expect(f.prisma.bot.update).not.toHaveBeenCalled();
});

it.each(["no default", "disconnected pin", "missing secret"])(
  "a bot with %s does not block saving a space destinations policy",
  async (missing) => {
    const f = fixture({ inherited: missing === "no default" });
    if (missing === "no default") f.prisma.spaceModelPreference.findFirst.mockResolvedValue(null);
    else if (missing === "disconnected pin")
      f.prisma.userModelCredential.findFirst.mockResolvedValue(null);
    else f.prisma.secret.findFirst.mockResolvedValue(null);
    expect((await f.call({ mode: "local" })).status).toBe(200);
    expect(f.prisma.space.update).toHaveBeenCalledOnce();
  },
);
it("only connected bots newly blocked by the space policy are named", async () => {
  const f = fixture({ inherited: true });
  f.prisma.spaceModelPreference.findFirst.mockImplementation(async ({ where }) =>
    where.userId === "owner-0"
      ? null
      : {
          modelId: "fixture-model",
          isDefault: true,
          credential: {
            id: "connection-1",
            provider: "openai-compatible",
            userId: "owner-1",
            label: "Fixture",
            secretId: "secret-1",
            defaultModel: "fixture-model",
            isDefault: true,
          },
        },
  );
  const result = await f.call({ mode: "local" });
  expect(result).toMatchObject({
    status: 400,
    body: { json: { data: { blockedBots: [{ id: "bot-1", name: "Beta" }] } } },
  });
  expect(f.prisma.space.update).not.toHaveBeenCalled();
});

it.each([false, true])(
  "policy saves check group-room member snapshots (bot policy: %s)",
  async (botPolicy) => {
    const f = fixture({ baseUrl: "http://localhost:11434/v1" });
    for (const bot of f.bots)
      bot.groupMembers = [
        {
          runtimePin: {
            runtimeKind: "codex-app-server",
            provider: "openai",
            modelId: "fixture-native",
            credentialId: "native:codex-app-server",
            effort: "off",
            revision: 1,
          },
        },
        {
          runtimePin: {
            runtimeKind: "codex-app-server",
            provider: "openai",
            modelId: "fixture-native",
            credentialId: "native:codex-app-server",
            effort: "off",
            revision: 2,
          },
        },
      ];
    const result = await f.call(
      { mode: "local" },
      botPolicy ? { ...actor, userId: "owner-0" } : actor,
      botPolicy ? "bot-0" : undefined,
    );
    expect(result).toMatchObject({
      status: 400,
      body: {
        json: {
          message: failureCategoryMessage(botPolicy ? "destinations-bot" : "destinations-space", {
            bot: "this bot",
          }),
          data: {
            blockedBots: botPolicy
              ? [{ id: "bot-0", name: "Alpha" }]
              : [
                  { id: "bot-0", name: "Alpha" },
                  { id: "bot-1", name: "Beta" },
                ],
          },
        },
      },
    });
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
    expect(f.prisma.space.update).not.toHaveBeenCalled();
    const query = botPolicy ? f.prisma.bot.findFirstOrThrow : f.prisma.bot.findMany;
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          groupMembers: {
            where: { group: { spaceId: "space", archivedAt: null } },
            select: { runtimePin: true },
          },
        },
      }),
    );
  },
);
it("a local room override and a cleared override do not block a local policy", async () => {
  const f = fixture({ provider: "ollama", baseUrl: "http://localhost:11434/v1" });
  f.bots[0]!.groupMembers = [
    {
      runtimePin: {
        runtimeKind: "pi",
        provider: "ollama",
        modelId: "fixture-model",
        credentialId: "connection-0",
        effort: null,
        revision: 1,
      },
    },
    { runtimePin: null },
  ];
  expect((await f.call({ mode: "local" })).status).toBe(200);
});
