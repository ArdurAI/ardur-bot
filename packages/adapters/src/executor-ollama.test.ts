import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelKey } from "./executor.js";
import { requestedBotPin } from "./pin-resolution.js";
import { resolveRunModelPin } from "./run-model-pin.js";

const http = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("./undici-fetch.js", () => ({ dispatcherFetch: http.fetch }));
afterEach(() => vi.resetAllMocks());

function fixture(reasoning = true) {
  let installed = true;
  http.fetch.mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/tags")
      return Response.json({ models: installed ? [{ name: "qwen3:8b" }] : [] });
    if (path === "/api/show")
      return Response.json({
        capabilities: reasoning ? ["thinking", "completion"] : ["completion"],
        model_info: { "qwen3.context_length": 40960 },
      });
    throw new Error("Inference must not run during pin resolution");
  });
  const credential = {
    id: "connection",
    provider: "ollama",
    secretId: "secret",
    defaultModel: "qwen3:8b",
  };
  const prisma = {
    userModelCredential: { findFirst: vi.fn(async () => credential) },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({ credential, modelId: "qwen3:8b", isDefault: true })),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "encrypted" })) },
    space: { findUnique: vi.fn(async () => ({ allowedModelDestinations: { mode: "local" } })) },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    secretStore: {
      load: () => JSON.stringify({ kind: "openai_compatible", baseUrl: "http://127.0.0.1:11434" }),
    },
  } as unknown as Parameters<typeof resolveModelKey>[0];
  const pin: RuntimePin = {
    provider: "ollama",
    modelId: "qwen3:8b",
    effort: reasoning ? "low" : null,
    credentialId: "connection",
    revision: 1,
    runtimeKind: "pi",
  };
  return {
    pin,
    remove: () => {
      installed = false;
    },
    prisma,
    input: {
      prisma,
      scope: { userId: "user", spaceId: "space" },
      scripted: false,
      bot: {},
      snapshot: pin,
      loadKey: async (
        _credential: unknown,
        requested: RuntimePin,
        selectDefaultEffort?: boolean,
      ): Promise<AgentRunModel> => {
        const { oauth: _oauth, ...key } = await resolveModelKey(
          deps,
          "user",
          "space",
          credential,
          "ollama",
          requested.modelId!,
          undefined,
          selectDefaultEffort ? undefined : requested,
        );
        return { provider: "ollama", id: requested.modelId!, ...key };
      },
    },
  };
}

describe("Ollama run pins", () => {
  it("resolves the selected connection without any environment model list", async () => {
    const { input, pin } = fixture();
    expect(await resolveRunModelPin(input)).toMatchObject({
      kind: "resolved",
      pin,
      provider: "ollama",
      id: "qwen3:8b",
      thinkingLevel: "low",
      baseUrl: "http://127.0.0.1:11434/v1",
      contextWindow: 40960,
    });
  });
  it("rechecks installed models and fails closed when a snapshotted model disappears", async () => {
    const f = fixture();
    expect(await resolveRunModelPin(f.input)).toHaveProperty("kind", "resolved");
    f.remove();
    expect(await resolveRunModelPin(f.input)).toMatchObject({
      kind: "problem",
      code: "pin-model-unknown",
      pin: f.pin,
      actions: ["connect", "change-pin"],
    });
    expect(
      http.fetch.mock.calls.every(([url]) => new URL(String(url)).hostname === "127.0.0.1"),
    ).toBe(true);
  });
  it("preserves not-applicable effort as null", async () => {
    const f = fixture(false);
    expect(await resolveRunModelPin(f.input)).toMatchObject({
      kind: "resolved",
      pin: { effort: null },
      thinkingLevel: "off",
    });
  });
  it("discovers default effort before creating a space-default run snapshot", async () => {
    for (const reasoning of [false, true]) {
      const f = fixture(reasoning);
      expect(await resolveRunModelPin({ ...f.input, snapshot: undefined })).toMatchObject({
        kind: "resolved",
        pin: { provider: "ollama", effort: reasoning ? "medium" : null },
      });
    }
  });
  it("rejects a stale effort when the model no longer supports thinking", async () => {
    const f = fixture(false);
    expect(
      await resolveRunModelPin({ ...f.input, snapshot: { ...f.pin, effort: "high" } }),
    ).toMatchObject({ kind: "problem", code: "pin-effort-unsupported" });
  });
  it("records an inherited space model with explicit thinking off as none", async () => {
    const f = fixture();
    expect(
      await resolveRunModelPin({ ...f.input, snapshot: undefined, bot: { thinkingLevel: "off" } }),
    ).toMatchObject({
      kind: "resolved",
      pin: { provider: "ollama", effort: "none" },
      thinkingLevel: "off",
    });
  });
  it("snapshots the existing off storage value as Ollama none", () => {
    expect(
      requestedBotPin({ modelProvider: "ollama", modelId: "qwen3:8b", thinkingLevel: "off" })
        .effort,
    ).toBe("none");
  });
});
