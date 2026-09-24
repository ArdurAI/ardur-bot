import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { listPiCatalog } from "./pi-models.js";
import { AnthropicOAuthUnavailableError, resolveModelAuth } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import { modelsForRequest, resolveRuntimeModel } from "./pi-runtime.js";

function requestModel(id: string, baseUrl: string): Pick<AgentRunRequest, "model"> {
  return { model: { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id, baseUrl } };
}

describe("request model catalogs", () => {
  it("rejects a serialized OAuth credential disguised as an Anthropic runtime API key", () => {
    expect(() =>
      resolveRuntimeModel({
        provider: "anthropic",
        id: "claude-opus-5",
        apiKey: JSON.stringify({ access: "test-access", refresh: "test-refresh", expires: 1 }),
      }),
    ).toThrow(AnthropicOAuthUnavailableError);
  });
  it("rejects directly supplied Anthropic OAuth before creating a provider catalog", () => {
    expect(() =>
      modelsForRequest(
        {
          model: {
            provider: "anthropic",
            id: "claude-opus-5",
            oauth: {
              credential: {
                type: "oauth",
                access: "test-access",
                refresh: "test-refresh",
                expires: 1,
              },
            },
          },
        },
        "anthropic",
      ),
    ).toThrow(AnthropicOAuthUnavailableError);
  });
  it.each([
    ["openrouter", "openai/gpt-5.6-luna"],
    ["openai-codex", "gpt-6-astra"],
    ["openai-codex", "gpt-6-luna"],
    ["openai-codex", "gpt-6-sol"],
    ["anthropic", "claude-fable-5-1"],
    ["anthropic", "claude-opus-5-5"],
  ])("offers and resolves %s/%s with vision", (provider, id) => {
    const entry = listPiCatalog().find((model) => model.provider === provider && model.id === id);
    expect(entry).toBeDefined();
    const model = modelsForRequest({ model: { provider, id } }, provider).getModel(provider, id);
    expect(model).toBeDefined();
    expect(model?.input).toContain("image");
    expect(modelAcceptsImageInput(provider, id)).toBe(true);
    expect(entry?.thinkingLevels).toEqual(getSupportedThinkingLevels(model!));
    if (provider === "openai-codex") {
      expect(entry?.signIn).toBe("device-code");
      expect(entry?.thinkingLevels).toContain("max");
    }
    if (provider === "anthropic") {
      expect(entry?.signIn).toBeUndefined();
      expect(entry?.auth).toBe("api-key");
      expect(entry?.thinkingLevels).toContain("max");
    }
  });

  it("isolates concurrent OpenAI-compatible endpoint registrations", () => {
    const first = modelsForRequest(
      requestModel("first-model", "http://127.0.0.1:8001/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const second = modelsForRequest(
      requestModel("second-model", "http://127.0.0.1:8002/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(first).not.toBe(second);
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "first-model")?.baseUrl).toBe(
      "http://127.0.0.1:8001/v1",
    );
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")).toBeUndefined();
    expect(second.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")?.baseUrl).toBe(
      "http://127.0.0.1:8002/v1",
    );
  });

  it("applies a connected model's image capability to the runtime model", () => {
    const models = modelsForRequest(
      {
        model: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          id: "vision-model",
          baseUrl: "http://127.0.0.1:8000/v1",
          acceptsImages: true,
        },
      },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "vision-model")?.input).toContain(
      "image",
    );
  });
});

it.each([true, false, undefined])(
  "keeps saved capability %s consistent between metadata and runtime",
  async (reasoning) => {
    const plaintext = buildModelConnectPlaintext({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      modelId: "same-model",
      baseUrl: "http://localhost:8000/v1",
      reasoning,
    });
    const auth = await resolveModelAuth(plaintext, OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(auth.secret.kind).toBe("openai_compatible");
    if (auth.secret.kind !== "openai_compatible") throw new Error("Wrong credential type");
    const models = modelsForRequest(
      {
        model: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          id: "same-model",
          baseUrl: auth.secret.baseUrl,
          reasoning: auth.secret.reasoning,
        },
      },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "same-model")!;
    const credential = modelCredentialDto(
      {
        id: "cred",
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        label: "Server",
        isDefault: true,
        defaultModel: "same-model",
      },
      plaintext,
    );
    expect(model.reasoning).toBe(reasoning ?? false);
    expect(credential.thinkingLevels).toEqual(getSupportedThinkingLevels(model));
  },
);

describe("resolveRuntimeModel", () => {
  it("does not treat a stringified null as a catalog model", () => {
    const resolved = resolveRuntimeModel({ provider: "anthropic", id: "null" });
    expect(resolved.modelId).toBe("");
    expect(resolved.model).toBeUndefined();
    expect(resolved.provider).toBe("anthropic");
  });
});

it("does not look up a pinned model on OpenRouter under another provider", () => {
  const pin = {
    provider: "xai",
    modelId: "openai/gpt-5.6-luna",
    effort: "high",
    credentialId: "connection",
    revision: 1,
  };
  const result = resolveRuntimeModel({
    provider: pin.provider,
    id: pin.modelId,
    apiKey: "test-key",
    runtimePin: pin,
  });
  expect(result.provider).toBe("xai");
  expect(result.model).toBeUndefined();
});

it("rejects a pinned request without its key before environment credential recovery", () => {
  const pin = {
    provider: "openrouter",
    modelId: "openai/gpt-5.6-luna",
    effort: "high",
    credentialId: "connection",
    revision: 1,
  };
  expect(() =>
    resolveRuntimeModel({ provider: pin.provider, id: pin.modelId, runtimePin: pin }),
  ).toThrow(
    expect.objectContaining({
      problem: expect.objectContaining({ code: "pin-credential-missing", pin }),
    }),
  );
});

it("requires the bound endpoint for a pinned keyless custom model", () => {
  const pin = {
    provider: "openai-compatible",
    modelId: "local-model",
    effort: "off",
    credentialId: "connection",
    revision: 1,
  };
  expect(() =>
    resolveRuntimeModel({ provider: pin.provider, id: pin.modelId, runtimePin: pin }),
  ).toThrow(
    expect.objectContaining({
      problem: expect.objectContaining({ code: "pin-credential-missing" }),
    }),
  );
  expect(
    resolveRuntimeModel({
      provider: pin.provider,
      id: pin.modelId,
      runtimePin: pin,
      baseUrl: "http://localhost:8080/v1",
    }),
  ).toMatchObject({
    model: { provider: pin.provider, id: pin.modelId, baseUrl: "http://localhost:8080/v1" },
    apiKey: "local",
  });
});
