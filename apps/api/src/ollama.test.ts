import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { botModelPinUpdate } from "./bot-model-pin.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const http = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("../../../packages/adapters/src/undici-fetch.js", () => ({ dispatcherFetch: http.fetch }));
afterEach(() => vi.resetAllMocks());

function fixture(owner = true, connected = true) {
  const credential = { id: "connection", provider: "ollama", secretId: "secret", label: "Ollama" };
  const actor: Actor = {
    userId: "user",
    spaceId: "space",
    email: "test@ardurbot.test",
    isDeploymentOwner: owner,
  };
  const deps = {
    env: { deploymentKind: "source", agentRuntime: "pi" },
    prisma: {
      userModelCredential: { findFirst: vi.fn(async () => (connected ? credential : null)) },
      spaceModelPreference: {
        findFirst: vi.fn(async () => (connected ? { credential, modelId: "llama3.2:1b" } : null)),
      },
      secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "encrypted" })) },
    },
    secrets: {
      load: () => JSON.stringify({ kind: "openai_compatible", baseUrl: "http://127.0.0.1:11434" }),
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const rpc = async (method: string, input?: unknown) => {
    const result = await handler.handle(
      new Request(`http://127.0.0.1/rpc/models/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: input ?? {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return result.response;
  };
  http.fetch.mockImplementation(async (url) => {
    if (String(url).endsWith("/version")) return Response.json({ version: "test-version" });
    if (String(url).endsWith("/tags"))
      return Response.json({
        models: [{ name: "llama3.2:1b", details: { parameter_size: "1B" } }],
      });
    return Response.json({
      capabilities: ["completion"],
      model_info: { "llama.context_length": 8192 },
    });
  });
  return { actor, deps, rpc };
}

describe("Ollama connection API", () => {
  it("persists a keyless empty connection without replacing the current space default", async () => {
    const f = fixture(true, false);
    http.fetch.mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith("/version") ? { version: "test-version" } : { models: [] },
      ),
    );
    const put = vi.fn(async (_plaintext: string, _context: unknown) => ({
      id: "new-secret",
      ciphertext: "encrypted",
    }));
    const select = vi.fn();
    const tx = {
      userModelCredential: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => ({ id: "new-connection", provider: "ollama", label: "ollama" })),
      },
      secret: { create: vi.fn(async () => ({ id: "new-secret" })) },
      spaceModelPreference: {
        findFirst: vi.fn(async () => null),
        updateMany: select,
        upsert: select,
      },
    };
    f.deps.secrets.put = put as unknown as RouterDeps["secrets"]["put"];
    f.deps.prisma.$transaction = vi.fn(async (run: (db: typeof tx) => Promise<unknown>) =>
      run(tx),
    ) as unknown as PrismaClient["$transaction"];
    const response = await f.rpc("connect", {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      json: {
        provider: "ollama",
        hasKey: true,
        isDefault: false,
        baseUrl: "http://127.0.0.1:11434",
      },
    });
    expect(JSON.parse(put.mock.calls[0]?.[0] as unknown as string)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(select).not.toHaveBeenCalled();
  });
  it("reports the default from the server deployment kind before a connection exists", async () => {
    const f = fixture(true, false);
    expect(await (await f.rpc("ollama")).json()).toMatchObject({
      json: { baseUrl: "http://127.0.0.1:11434", models: [], canPull: true },
    });
    f.deps.env.deploymentKind = "packaged";
    expect(await (await f.rpc("ollama")).json()).toMatchObject({
      json: { baseUrl: "http://host.docker.internal:11434" },
    });
    expect(http.fetch).not.toHaveBeenCalled();
  });
  it("lists keyless Ollama models in the shared catalog", async () => {
    const f = fixture();
    const data = await (await f.rpc("list")).json();
    expect(data.json).toContainEqual(
      expect.objectContaining({
        provider: "ollama",
        id: "llama3.2:1b",
        label: "llama3.2:1b · 1B",
        credentialId: "connection",
        thinkingLevels: [],
      }),
    );
  });
  it("prevents a non-owner from pulling before any network request", async () => {
    const f = fixture(false);
    expect((await f.rpc("pullOllama", { model: "llama3.2:1b" })).status).toBe(403);
    expect(http.fetch).not.toHaveBeenCalled();
  });
  it("keeps disconnected and empty states visible without exposing raw errors", async () => {
    const f = fixture();
    http.fetch.mockRejectedValue(
      new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    );
    expect(
      await (await f.rpc("testOllama", { baseUrl: "http://127.0.0.1:11434" })).json(),
    ).toMatchObject({
      json: { models: [], issue: "Ollama is not running. Start it and try again." },
    });
  });
  it("stores null effort for a model without thinking and binds the connection", async () => {
    const f = fixture();
    const update = await botModelPinUpdate(
      f.deps,
      f.actor,
      { modelProvider: null, modelId: null, modelCredentialId: null, thinkingLevel: null },
      {
        botId: "bot",
        modelProvider: "ollama",
        modelId: "llama3.2:1b",
        modelCredentialId: "connection",
      },
    );
    expect(update).toMatchObject({
      modelProvider: "ollama",
      modelId: "llama3.2:1b",
      modelCredentialId: "connection",
      thinkingLevel: null,
    });
  });
  it("rejects pinning a vanished model", async () => {
    const f = fixture();
    http.fetch.mockResolvedValue(Response.json({ models: [] }));
    await expect(
      botModelPinUpdate(
        f.deps,
        f.actor,
        { modelProvider: null, modelId: null, modelCredentialId: null, thinkingLevel: null },
        {
          botId: "bot",
          modelProvider: "ollama",
          modelId: "llama3.2:1b",
          modelCredentialId: "connection",
        },
      ),
    ).rejects.toThrow("not installed");
  });
});
