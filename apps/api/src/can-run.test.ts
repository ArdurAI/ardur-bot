import { listOllamaModels, nativeRuntimeAvailability, showOllamaModel } from "@ardurbot/adapters";
import type { Actor, RuntimeKind } from "@ardurbot/contracts";
import { failureCategoryMessage, HERMES_CONTEXT_LIMIT_MESSAGE } from "@ardurbot/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import { updateGroupMemberModelPin } from "./group-model-pin.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<object>()),
  listOllamaModels: vi.fn(),
  showOllamaModel: vi.fn(),
  nativeRuntimeAvailability: vi.fn(async () => ({
    runtimeKind: "codex-app-server",
    available: true,
    models: [{ id: "fixture-native", label: "Fixture", efforts: ["off"] }],
  })),
}));
const actor = { userId: "user", spaceId: "space" } as Actor;
const rows: {
  name: string;
  kind: RuntimeKind;
  computer?: string;
  experimental?: boolean;
  missing?: boolean;
  local?: boolean;
  window?: number;
  category?:
    | "experimental-off"
    | "computer-unsupported"
    | "connection-missing"
    | "destinations-space";
}[] = [
  {
    name: "Codex in sandbox",
    kind: "codex-app-server",
    computer: "docker",
    category: "computer-unsupported",
  },
  { name: "Experimental off", kind: "hermes", experimental: false, category: "experimental-off" },
  { name: "space local only", kind: "pi", local: true, category: "destinations-space" },
  { name: "disconnected model", kind: "pi", missing: true, category: "connection-missing" },
  { name: "Hermes context floor", kind: "hermes", window: 8_192 },
];
function fixture(row: (typeof rows)[number]) {
  const native = row.kind === "codex-app-server";
  const pin = {
    runtimeKind: row.kind,
    provider: native ? "openai" : "openai-compatible",
    modelId: native ? "fixture-native" : "fixture-model",
    effort: "off",
    credentialId: native ? "native:codex-app-server" : "connection",
  };
  const bot = {
    id: "bot",
    userId: "user",
    spaceId: "space",
    modelProvider: pin.provider,
    modelId: pin.modelId,
    modelCredentialId: pin.credentialId,
    thinkingLevel: "off",
    runtimeKind: row.kind,
    runtimeExperimental: row.experimental ?? true,
    runtimeConfig: null,
    modelPinRevision: 1,
    name: "Renamed",
    title: "",
    description: "",
    instructions: "",
    color: "#000",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    parentBotId: null,
    archivedAt: null,
    memoryScope: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    runs: [],
    thread: { id: "thread", unread: false, messages: [] },
    computer: {
      kind: row.computer ?? "desktop",
      connectionId: null,
      spaceId: "space",
      scope: "dedicated",
    },
  };
  const credential = {
    id: "connection",
    userId: "user",
    provider: "openai-compatible",
    label: "Fixture",
    secretId: "secret",
  };
  const prisma = {
    computer: {
      findFirst: vi.fn(async () => ({
        kind: "docker",
        spaceId: "space",
        scope: "team",
        connectionId: null,
      })),
      findUnique: vi.fn(async () => null),
    },
    chatGroup: { findFirst: vi.fn(async () => ({ members: [{ id: "member", bot }] })) },
    bot: {
      findFirst: vi.fn(async () => bot),
      findMany: vi.fn(async () => [bot]),
      updateMany: vi.fn(),
      update: vi.fn(async () => ({ id: "bot", name: "Renamed", title: "", description: "" })),
    },
    botBrief: { updateMany: vi.fn() },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
    space: {
      findUnique: vi.fn(async () => ({
        allowedModelDestinations: { mode: row.local ? "local" : "any" },
      })),
    },
    userModelCredential: { findFirst: vi.fn(async () => (row.missing ? null : credential)) },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({ modelId: "fixture-model", isDefault: false })),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "fixture" })) },
    $transaction: vi.fn<(callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>>(),
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  const deps = {
    env: { webOrigin: "http://localhost" },
    prisma,
    events: { notify: vi.fn(async () => {}) },
    secrets: {
      load: () =>
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "https://models.example.com/v1",
          reasoning: false,
          thinkingLevel: "off",
          contextWindow: row.window ?? 65_536,
          maxTokens: 4096,
        }),
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(procedure: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://localhost/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response!.status, body: await response!.json() };
  }
  return { deps, prisma, call, pin, bot };
}
it.each(rows)("validation RPC refuses $name with the run sentence", async (row) => {
  const f = fixture(row);
  const result = await f.call("models/validatePin", {
    ...f.pin,
    botId: "bot",
    runtimeExperimental: f.bot.runtimeExperimental,
    computerLocation: "host",
  });
  const runtime =
    row.kind === "codex-app-server" ? "Codex" : row.kind === "pi" ? "Ardur" : "Hermes";
  const sentence = row.category
    ? failureCategoryMessage(row.category, { runtime, bot: "this bot" })
    : HERMES_CONTEXT_LIMIT_MESSAGE;
  expect(result).toMatchObject({ status: 400, body: { json: { message: sentence } } });
  expect(f.prisma.bot.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "bot", userId: "user", spaceId: "space", archivedAt: null },
    }),
  );
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});
it.each(rows)("save refuses $name without relying on a preview call", async (row) => {
  const f = fixture(row);
  const result = await f.call("bots/update", {
    botId: "bot",
    runtimeKind: f.pin.runtimeKind,
    modelProvider: f.pin.provider,
    modelId: f.pin.modelId,
    modelCredentialId: f.pin.credentialId,
    thinkingLevel: "off",
    runtimeExperimental: f.bot.runtimeExperimental,
  });
  const runtime =
    row.kind === "codex-app-server" ? "Codex" : row.kind === "pi" ? "Ardur" : "Hermes";
  const sentence = row.category
    ? failureCategoryMessage(row.category, { runtime, bot: "this bot" })
    : HERMES_CONTEXT_LIMIT_MESSAGE;
  expect(result).toMatchObject({ status: 400, body: { json: { message: sentence } } });
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
  expect(f.prisma.bot.updateMany).not.toHaveBeenCalled();
});
it("accepts valid settings without writing or probing a model API", async () => {
  const f = fixture({ name: "valid", kind: "hermes" });
  expect((await f.call("models/validatePin", { ...f.pin, botId: "bot" })).status).toBe(200);
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
  expect(nativeRuntimeAvailability).not.toHaveBeenCalled();
});

it.each(rows)("group save refuses $name through the actual checker", async (row) => {
  const f = fixture(row);
  const runtime =
    row.kind === "codex-app-server" ? "Codex" : row.kind === "pi" ? "Ardur" : "Hermes";
  const sentence = row.category
    ? failureCategoryMessage(row.category, { runtime, bot: "this bot" })
    : HERMES_CONTEXT_LIMIT_MESSAGE;
  await expect(
    updateGroupMemberModelPin(
      f.deps,
      actor,
      {
        groupId: "group",
        botId: "bot",
        memberId: "member",
        expectedRevision: 0,
      },
      f.pin,
    ),
  ).rejects.toThrow(sentence);
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});

it("the preview checks the existing Team computer rather than the bot's current host", async () => {
  const f = fixture({ name: "valid host Codex", kind: "codex-app-server" });
  const result = await f.call("models/validatePin", {
    ...f.pin,
    botId: "bot",
    computerMode: "team",
  });
  expect(result).toMatchObject({
    status: 400,
    body: {
      json: {
        message: failureCategoryMessage("computer-unsupported", {
          runtime: "Codex",
          bot: "this bot",
        }),
      },
    },
  });
  expect(f.prisma.computer.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { spaceId: "space", scope: "team" },
    }),
  );
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});
it("a sharing save cannot bypass the Team placement check or start moving files", async () => {
  const f = fixture({ name: "valid host Codex", kind: "codex-app-server" });
  const result = await f.call("bots/setComputer", { botId: "bot", mode: "team" });
  expect(result).toMatchObject({
    status: 400,
    body: {
      json: {
        message: failureCategoryMessage("computer-unsupported", {
          runtime: "Codex",
          bot: "this bot",
        }),
      },
    },
  });
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});

it.each(["pi", "hermes"] as const)(
  "a %s preview preserves the exact bound custom pin after the connection default changes",
  async (kind) => {
    const f = fixture({ name: "saved custom pin", kind });
    f.prisma.spaceModelPreference.findFirst.mockResolvedValue({
      modelId: "another-default",
      isDefault: false,
    });
    const result = await f.call("models/validatePin", { ...f.pin, botId: "bot" });
    expect(result.status).toBe(200);
    expect(f.prisma.bot.updateMany).not.toHaveBeenCalled();
  },
);

it("a non-scripted deployment refuses a client-supplied fixture pin", async () => {
  const f = fixture({ name: "production", kind: "pi" });
  const result = await f.call("models/validatePin", {
    runtimeKind: "pi",
    provider: "scripted",
    modelId: "scripted",
    credentialId: "scripted",
    effort: "off",
    botId: "bot",
  });
  expect(result.status).toBe(400);
});

it.each(rows)(
  "an inherited group preview refuses $name even if the client describes a different pin",
  async (row) => {
    const f = fixture(row);
    const result = await f.call("models/validatePin", {
      runtimeKind: "pi",
      provider: null,
      modelId: null,
      credentialId: null,
      effort: null,
      botId: "bot",
      inheritBotPin: true,
    });
    expect(result.status).toBe(400);
  },
);
it.each(rows)("clearing a group override cannot inherit $name", async (row) => {
  const f = fixture(row);
  await expect(
    updateGroupMemberModelPin(
      f.deps,
      actor,
      {
        groupId: "group",
        botId: "bot",
        memberId: "member",
        expectedRevision: 0,
      },
      null,
    ),
  ).rejects.toThrow();
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});

function ollamaFixture(kind: "pi" | "hermes") {
  const f = fixture({ name: "saved Ollama", kind });
  f.bot.modelProvider = "ollama";
  f.bot.thinkingLevel = "off";
  f.prisma.userModelCredential.findFirst.mockResolvedValue({
    id: "connection",
    userId: "user",
    provider: "ollama",
    label: "Fixture",
    secretId: "secret",
  });
  f.deps.secrets.load = () =>
    JSON.stringify({
      kind: "openai_compatible",
      baseUrl: "http://localhost:11434/v1",
    });
  vi.mocked(listOllamaModels)
    .mockReset()
    .mockRejectedValue(new Error("Ollama is not running. Start it and try again."));
  vi.mocked(showOllamaModel)
    .mockReset()
    .mockRejectedValue(new Error("Ollama is not running. Start it and try again."));
  return { ...f, pin: { ...f.pin, provider: "ollama" } };
}

it.each(["pi", "hermes"] as const)(
  "an unchanged %s Ollama pin never probes, including a name-only form save",
  async (kind) => {
    const f = ollamaFixture(kind);
    expect((await f.call("models/validatePin", { ...f.pin, botId: "bot" })).status).toBe(200);
    const result = await f.call("bots/update", {
      botId: "bot",
      name: "Renamed",
      runtimeKind: kind,
      modelProvider: "ollama",
      modelId: f.pin.modelId,
      modelCredentialId: f.pin.credentialId,
      thinkingLevel: "off",
      runtimeExperimental: true,
    });
    expect(result).toMatchObject({ status: 200 });
    expect(f.prisma.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Renamed" }),
      }),
    );
    expect(listOllamaModels).not.toHaveBeenCalled();
    expect(showOllamaModel).not.toHaveBeenCalled();
  },
);

it.each(["models/validatePin", "bots/update"])(
  "%s treats an unreachable changed Ollama pin as cannot check now, not invalid settings",
  async (procedure) => {
    const f = ollamaFixture("pi");
    const result = await f.call(
      procedure,
      procedure === "models/validatePin"
        ? { ...f.pin, modelId: "another-model", botId: "bot" }
        : {
            botId: "bot",
            modelProvider: "ollama",
            modelId: "another-model",
            modelCredentialId: "connection",
            thinkingLevel: "off",
          },
    );
    expect(result).toMatchObject({
      status: 412,
      body: {
        json: {
          code: "PRECONDITION_FAILED",
          message: "Ollama is not running. Start it and try again.",
        },
      },
    });
    expect(f.prisma.bot.update).not.toHaveBeenCalled();
  },
);

it("a changed Ollama pin still checks installed models and the Hermes floor", async () => {
  const f = ollamaFixture("hermes");
  vi.mocked(listOllamaModels).mockResolvedValue([{ name: "another-model" }]);
  vi.mocked(showOllamaModel).mockResolvedValue({
    id: "another-model",
    reasoning: false,
    acceptsImages: false,
    supportsThinkingOff: true,
    contextWindow: 8192,
  });
  const result = await f.call("models/validatePin", {
    ...f.pin,
    modelId: "another-model",
    effort: null,
    botId: "bot",
  });
  expect(result).toMatchObject({
    status: 400,
    body: { json: { message: HERMES_CONTEXT_LIMIT_MESSAGE } },
  });
  expect(showOllamaModel).toHaveBeenCalledTimes(1);
});
