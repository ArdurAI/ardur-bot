import type { Actor } from "@ardurbot/contracts";
import { HERMES_CONTEXT_LIMIT_MESSAGE } from "@ardurbot/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import { normalizeModelPinUpdate, validateModelPinSelection } from "./model-pin-validation.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = { userId: "user", spaceId: "space" } as Actor;

function fixture(
  reasoning: boolean,
  effort: "high" | "off",
  contextWindow: number | null = 65_536,
) {
  const credential = {
    id: "connection",
    userId: "user",
    provider: "openai-compatible",
    label: "Connection",
    secretId: "secret",
  };
  return {
    env: { webOrigin: "http://localhost" },
    prisma: {
      userModelCredential: { findFirst: vi.fn(async () => credential) },
      spaceModelPreference: {
        findFirst: vi.fn(async () => ({ modelId: "fixture-model", isDefault: false })),
      },
      secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "ciphertext" })) },
    },
    secrets: {
      load: () =>
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "http://localhost:8080/v1",
          reasoning,
          thinkingLevel: effort,
          ...(contextWindow === null ? {} : { contextWindow }),
          maxTokens: 4096,
        }),
    },
  } as unknown as RouterDeps;
}

describe("Hermes group pin validation", () => {
  it.each([
    { reasoning: true, effort: "high" as const },
    { reasoning: false, effort: "off" as const },
  ])("accepts the shared connection default effort $effort", async ({ reasoning, effort }) => {
    const deps = fixture(reasoning, effort);
    const pin = {
      runtimeKind: "hermes" as const,
      provider: "openai-compatible",
      modelId: "fixture-model",
      credentialId: "connection",
      effort,
    };
    await expect(validateModelPinSelection(deps, actor, pin)).resolves.toEqual(pin);
    await expect(validateModelPinSelection(deps, actor, { ...pin, effort: null })).rejects.toThrow(
      "Choose a model, effort and connection.",
    );
  });
});

const choice = {
  runtimeKind: "hermes" as const,
  provider: "openai-compatible",
  modelId: "fixture-model",
  credentialId: "connection",
  effort: "off",
};

async function checkPin(
  deps: RouterDeps,
  pin: typeof choice | (Omit<typeof choice, "runtimeKind"> & { runtimeKind: "pi" }),
  caller: Actor | null = actor,
) {
  const handler = new RPCHandler(createRouter(deps));
  const { response } = await handler.handle(
    new Request("http://localhost/rpc/models/validatePin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: pin }),
    }),
    { prefix: "/rpc", context: { actor: caller } },
  );
  return { status: response.status, body: await response.json() };
}

it.each([8_192, 32_768, 63_999])(
  "refuses a Hermes pin at %i at RPC level with the control named",
  async (window) => {
    const deps = fixture(false, "off", window);
    const result = await checkPin(deps, choice);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      json: { code: "BAD_REQUEST", message: HERMES_CONTEXT_LIMIT_MESSAGE },
    });
  },
);

it("does not refuse the built-in runtime at the same low window", async () => {
  expect(
    (await checkPin(fixture(false, "off", 8_192), { ...choice, runtimeKind: "pi" })).status,
  ).toBe(200);
});

it("accepts exactly the Hermes floor", async () => {
  expect((await checkPin(fixture(false, "off", 64_000), choice)).status).toBe(200);
});

it("requires authentication before checking a pin", async () => {
  expect((await checkPin(fixture(false, "off"), choice, null)).status).toBe(401);
});

it("revalidates a resubmitted Hermes pin after connection limits were lowered", async () => {
  const deps = fixture(false, "off", 8_192);
  await expect(
    normalizeModelPinUpdate(
      deps,
      actor,
      {
        runtimeKind: "hermes",
        modelProvider: choice.provider,
        modelId: choice.modelId,
        modelCredentialId: choice.credentialId,
        thinkingLevel: choice.effort,
      },
      {
        botId: "bot",
        runtimeKind: "hermes",
        modelProvider: choice.provider,
        modelId: choice.modelId,
        modelCredentialId: choice.credentialId,
        thinkingLevel: "off",
      },
    ),
  ).rejects.toThrow(HERMES_CONTEXT_LIMIT_MESSAGE);
});

it("accepts an unknown compatible model using the honest unsaved default", async () => {
  const deps = fixture(false, "off", null);
  expect((await checkPin(deps, choice)).status).toBe(200);
});
