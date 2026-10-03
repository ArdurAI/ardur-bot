import type { Actor } from "@ardurbot/contracts";
import * as hermesConfig from "@ardurbot/host-runtime/runtimes/hermes-config";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import { resolveModelKey } from "../../../packages/adapters/src/executor.js";
import { modelsForRequest } from "../../../packages/adapters/src/pi-runtime.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = { userId: "owner", spaceId: "space" } as Actor;
const pin = {
  runtimeKind: "hermes",
  provider: "openai-compatible",
  modelId: "fixture-model",
  credentialId: "connection",
  effort: "off",
};

function fixture(owner = true, contextWindow: number | null = 65_536) {
  const credential = {
    id: "connection",
    userId: "owner",
    provider: "openai-compatible",
    label: "Local",
    secretId: "secret",
  };
  const findCredential = vi.fn(async () => credential);
  const deps = {
    env: { webOrigin: "http://localhost" },
    prisma: {
      user: { findMany: vi.fn(async () => (owner ? [{ id: "owner" }] : [{ id: "other" }])) },
      userModelCredential: { findFirst: findCredential },
      spaceModelPreference: {
        findFirst: vi.fn(async () => ({ modelId: "fixture-model", isDefault: false })),
      },
      secret: {
        findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "sealed" })),
      },
    },
    secrets: {
      load: vi.fn(() =>
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "http://localhost:8080/v1",
          reasoning: false,
          ...(contextWindow === null ? {} : { contextWindow }),
          maxTokens: 4096,
        }),
      ),
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const preview = async (input: Record<string, unknown>, caller: Actor | null = actor) => {
    const { response } = await handler.handle(
      new Request("http://localhost/rpc/runtimeConfig/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: caller } },
    );
    return { status: response.status, body: await response.json() };
  };
  const builtinModel = async () => {
    const key = await resolveModelKey(
      { prisma: deps.prisma, secretStore: deps.secrets } as unknown as Parameters<
        typeof resolveModelKey
      >[0],
      actor.userId,
      actor.spaceId,
      credential,
      pin.provider,
      pin.modelId,
    );
    return modelsForRequest(
      { model: { ...key, provider: pin.provider, id: pin.modelId } },
      pin.provider,
    ).getModel(pin.provider, pin.modelId);
  };
  return { preview, findCredential, builtinModel };
}

describe("runtime configuration preview route", () => {
  it("requires authentication and a native host owner", async () => {
    const input = {
      runtimeKind: "hermes",
      pin,
      runtimeConfig: { version: 2, runtimeKind: "hermes" },
    };
    expect((await fixture().preview(input, null)).status).toBe(401);
    expect((await fixture(false).preview(input)).status).toBe(403);
  });

  it("expands a partial draft using the selected Hermes model", async () => {
    const { preview } = fixture();
    const result = await preview({
      runtimeKind: "hermes",
      pin,
      runtimeConfig: { version: 2, runtimeKind: "hermes" },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      json: {
        issues: [],
        preview: {
          settings: {
            limits: { maxProviderRequests: 16, timeoutMs: 180000 },
            context: { maxInputBytes: 16384, overflow: "trim" },
          },
          managed: { model: "fixture-model" },
        },
      },
    });
  });

  it("returns field reasons for forbidden keys without looking up credentials", async () => {
    const { preview, findCredential } = fixture();
    const result = await preview({
      runtimeKind: "hermes",
      pin,
      runtimeConfig: { version: 2, runtimeKind: "hermes", providers: { token: "fake" } },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      json: { issues: [{ code: "managed-connection", reasonId: "managed-connection" }] },
    });
    expect(findCredential).not.toHaveBeenCalled();
  });

  it("rejects a pin for another runtime and another owner's connection", async () => {
    const { preview, findCredential } = fixture();
    expect(
      (
        await preview({
          runtimeKind: "hermes",
          pin: { ...pin, runtimeKind: "pi" },
          runtimeConfig: { version: 2, runtimeKind: "hermes" },
        })
      ).status,
    ).toBe(400);
    expect(findCredential).not.toHaveBeenCalled();
    findCredential.mockResolvedValueOnce(null as never);
    expect(
      (
        await preview({
          runtimeKind: "hermes",
          pin,
          runtimeConfig: { version: 2, runtimeKind: "hermes" },
        })
      ).status,
    ).toBe(400);
  });
});

it("previews a connection without saved context using the same resolved default", async () => {
  const { preview, builtinModel } = fixture(true, null);
  const compile = vi.spyOn(hermesConfig, "compileHermesRuntimeConfig");
  try {
    const result = await preview({
      runtimeKind: "hermes",
      pin,
      runtimeConfig: { version: 2, runtimeKind: "hermes" },
    });
    expect(result.status).toBe(200);
    expect(result.body.json.preview.managed.model).toBe(pin.modelId);
    expect(compile).toHaveBeenCalledOnce();
    const compiled = compile.mock.results[0]?.value as ReturnType<
      typeof hermesConfig.compileHermesRuntimeConfig
    >;
    expect(compiled.manifest.model.contextWindow).toBe(65_536);
    expect(compiled.manifest.generatedConfig).toMatchObject({ model: { context_length: 65_536 } });
    expect(result.body.json.preview).toEqual(compiled.preview);
    expect((await builtinModel())?.contextWindow).toBe(32_768);
  } finally {
    compile.mockRestore();
  }
});
