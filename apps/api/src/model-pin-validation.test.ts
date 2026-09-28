import type { Actor } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { validateModelPinSelection } from "./model-pin-validation.js";
import type { RouterDeps } from "./router.js";

const actor = { userId: "user", spaceId: "space" } as Actor;

function fixture(reasoning: boolean, effort: "high" | "off") {
  const credential = {
    id: "connection",
    userId: "user",
    provider: "openai-compatible",
    label: "Connection",
    secretId: "secret",
  };
  return {
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
          contextWindow: 32_768,
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
