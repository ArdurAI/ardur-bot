import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { hermesCompatibility } from "./hermes-compatibility.js";

function pin(patch: Partial<RuntimePin> = {}): RuntimePin {
  return {
    runtimeKind: "hermes",
    provider: "openai-compatible",
    modelId: "fixture-model",
    effort: "off",
    credentialId: "connection",
    revision: 1,
    ...patch,
  };
}

function model(
  patch: Partial<Parameters<typeof hermesCompatibility>[1]> = {},
): Parameters<typeof hermesCompatibility>[1] {
  return {
    provider: "openai-compatible",
    id: "fixture-model",
    apiKey: "fixture-key",
    baseUrl: "http://127.0.0.1:8080/v1",
    contextWindow: 32_768,
    maxTokens: 4_096,
    thinkingLevel: "off",
    ...patch,
  };
}

const oauthMarker: AgentRunModel["oauth"] = {
  credential: { type: "oauth", access: "access", refresh: "refresh", expires: 0 },
};

describe("hermesCompatibility", () => {
  it("ignores non-Hermes pins", () => {
    expect(hermesCompatibility(pin({ runtimeKind: "pi" }), model())).toBeUndefined();
  });

  it("requires a complete bound pin", () => {
    expect(hermesCompatibility(pin({ credentialId: null }), model())).toMatchObject({
      code: "pin-incomplete",
      reason: "Choose a connected model for Hermes.",
    });
    expect(hermesCompatibility(pin({ credentialId: "native:claude-code" }), model())).toMatchObject(
      { code: "pin-incomplete" },
    );
    expect(hermesCompatibility(pin({ modelId: "other" }), model())).toMatchObject({
      code: "pin-incomplete",
    });
  });

  it("allows an OpenAI-compatible connection with a direct endpoint", () => {
    expect(hermesCompatibility(pin(), model())).toBeUndefined();
    expect(
      hermesCompatibility(
        pin({ provider: "ollama", modelId: "llama-fixture" }),
        model({ provider: "ollama", id: "llama-fixture", apiKey: undefined }),
      ),
    ).toBeUndefined();
  });

  it("refuses a custom endpoint without a URL", () => {
    expect(hermesCompatibility(pin(), model({ baseUrl: undefined }))).toMatchObject({
      code: "runtime-unsupported-protocol",
      reason: "This connection cannot run Hermes.",
    });
  });

  it.each([
    { provider: "anthropic", id: "claude-opus-5", effort: "high" },
    { provider: "google", id: "gemini-3.1-pro-preview", effort: "high" },
    { provider: "google-vertex", id: "gemini-3.1-pro-preview", effort: "high" },
    { provider: "openai", id: "gpt-4.1", effort: "off" },
    { provider: "openrouter", id: "z-ai/glm-5.2", effort: "high" },
    { provider: "zai", id: "glm-5.2", effort: "high" },
    { provider: "kimi-coding", id: "kimi-for-coding", effort: "high" },
    { provider: "xai", id: "grok-4.6", effort: "high" },
  ])("allows a key-based $provider connection through the translated route", (entry) => {
    expect(
      hermesCompatibility(
        pin({ provider: entry.provider, modelId: entry.id, effort: entry.effort }),
        model({
          provider: entry.provider,
          id: entry.id,
          baseUrl: undefined,
          thinkingLevel: entry.effort as AgentRunModel["thinkingLevel"],
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses a Claude subscription with the vendor reason", () => {
    expect(
      hermesCompatibility(
        pin({ provider: "anthropic", modelId: "claude-opus-5" }),
        model({
          provider: "anthropic",
          id: "claude-opus-5",
          baseUrl: undefined,
          oauth: oauthMarker,
        }),
      ),
    ).toMatchObject({
      code: "runtime-unsupported-protocol",
      reason:
        "Claude subscriptions only work in Anthropic's own apps; add an Anthropic API key to use Claude with Hermes.",
    });
  });

  it("refuses a ChatGPT sign-in with the vendor reason, even without an OAuth marker", () => {
    for (const oauth of [oauthMarker, undefined]) {
      expect(
        hermesCompatibility(
          pin({ provider: "openai-codex", modelId: "gpt-6-astra" }),
          model({ provider: "openai-codex", id: "gpt-6-astra", baseUrl: undefined, oauth }),
        ),
      ).toMatchObject({
        code: "runtime-unsupported-protocol",
        reason:
          "ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes.",
      });
    }
  });

  it("refuses any other sign-in connection with the generic reason", () => {
    expect(
      hermesCompatibility(
        pin({ provider: "xai", modelId: "grok-4.6" }),
        model({ provider: "xai", id: "grok-4.6", baseUrl: undefined, oauth: oauthMarker }),
      ),
    ).toMatchObject({
      code: "runtime-unsupported-protocol",
      reason: "Add an API key connection to use this provider with Hermes.",
    });
    expect(
      hermesCompatibility(
        pin({ provider: "github-copilot", modelId: "gpt-4.1" }),
        model({
          provider: "github-copilot",
          id: "gpt-4.1",
          baseUrl: undefined,
          oauth: oauthMarker,
        }),
      ),
    ).toMatchObject({
      code: "runtime-unsupported-protocol",
      reason: "Add an API key connection to use this provider with Hermes.",
    });
  });

  it("refuses a provider the broker cannot serve", () => {
    expect(
      hermesCompatibility(
        pin({ provider: "scripted", modelId: "scripted" }),
        model({ provider: "scripted", id: "scripted", baseUrl: undefined }),
      ),
    ).toMatchObject({
      code: "runtime-unsupported-protocol",
      reason: "This connection cannot run Hermes.",
    });
    expect(
      hermesCompatibility(
        pin({ provider: "anthropic", modelId: "claude-unknown" }),
        model({ provider: "anthropic", id: "claude-unknown", baseUrl: undefined }),
      ),
    ).toMatchObject({
      code: "runtime-unsupported-protocol",
      reason: "This connection cannot run Hermes.",
    });
  });

  it("keeps the bounded-limits and effort checks on every route", () => {
    expect(
      hermesCompatibility(
        pin({ provider: "anthropic", modelId: "claude-opus-5" }),
        model({
          provider: "anthropic",
          id: "claude-opus-5",
          baseUrl: undefined,
          maxTokens: 131_072,
        }),
      ),
    ).toMatchObject({ code: "runtime-configuration-invalid" });
    expect(
      hermesCompatibility(
        pin({ provider: "anthropic", modelId: "claude-opus-5", effort: "high" }),
        model({
          provider: "anthropic",
          id: "claude-opus-5",
          baseUrl: undefined,
          thinkingLevel: "low",
        }),
      ),
    ).toMatchObject({ code: "pin-effort-unsupported" });
  });
});
