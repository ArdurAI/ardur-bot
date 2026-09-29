import type { Actor } from "@ardurbot/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
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

function fixture(owner = true) {
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
          contextWindow: 32768,
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
  return { preview, findCredential };
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
