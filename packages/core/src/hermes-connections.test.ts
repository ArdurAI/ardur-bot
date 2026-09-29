import type { ModelCredential } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import type { HermesConnectionRefusal } from "./hermes-connections.js";
import {
  HERMES_CONNECTION_POLICY,
  hermesConnectionRefusal,
  isHermesPassThroughProvider,
} from "./hermes-connections.js";

describe("HERMES_CONNECTION_POLICY", () => {
  it("allows every pass-through provider in the table", () => {
    expect(HERMES_CONNECTION_POLICY.passThroughProviders.length).toBeGreaterThan(0);
    for (const provider of HERMES_CONNECTION_POLICY.passThroughProviders) {
      expect(isHermesPassThroughProvider(provider)).toBe(true);
      expect(hermesConnectionRefusal(provider)).toBeUndefined();
      expect(hermesConnectionRefusal(provider, { oauth: false })).toBeUndefined();
    }
  });

  it("produces every refusal id from its own table row", () => {
    expect(HERMES_CONNECTION_POLICY.signInRefusals.length).toBeGreaterThan(0);
    for (const rule of HERMES_CONNECTION_POLICY.signInRefusals) {
      const provider = rule.provider ?? "fixture-provider";
      const credential: Pick<ModelCredential, "oauth" | "connectionIssue"> | undefined =
        rule.credential === "oauth"
          ? { oauth: true }
          : rule.credential === "api-key-required"
            ? { connectionIssue: "api-key-required" }
            : undefined;
      expect(hermesConnectionRefusal(provider, credential), JSON.stringify(rule)).toBe(
        rule.refusal,
      );
    }
  });

  it("writes one English sentence for every refusal id the rules can produce", () => {
    const ruledIds = new Set(HERMES_CONNECTION_POLICY.signInRefusals.map((rule) => rule.refusal));
    expect(Object.keys(HERMES_CONNECTION_POLICY.refusalSentences).sort()).toEqual(
      [...ruledIds].sort(),
    );
    for (const sentence of Object.values(HERMES_CONNECTION_POLICY.refusalSentences))
      expect(sentence.trim().length).toBeGreaterThan(0);
  });
});

describe("hermesConnectionRefusal", () => {
  it("allows an unselected provider and key-based catalog connections", () => {
    expect(hermesConnectionRefusal(undefined)).toBeUndefined();
    expect(hermesConnectionRefusal(null)).toBeUndefined();
    for (const provider of [
      "anthropic",
      "google",
      "google-vertex",
      "openai",
      "openrouter",
      "kimi-coding",
      "zai",
      "xai",
    ])
      expect(hermesConnectionRefusal(provider)).toBeUndefined();
    expect(hermesConnectionRefusal("xai", { oauth: false })).toBeUndefined();
  });

  it("refuses a ChatGPT sign-in by provider alone, ahead of any credential rule", () => {
    expect(hermesConnectionRefusal("openai-codex")).toBe("chatgpt-sign-in");
    expect(hermesConnectionRefusal("openai-codex", { oauth: true })).toBe("chatgpt-sign-in");
  });

  it("prefers the Claude subscription reason over the generic sign-in one", () => {
    expect(hermesConnectionRefusal("anthropic", { connectionIssue: "api-key-required" })).toBe(
      "claude-subscription",
    );
    expect(hermesConnectionRefusal("anthropic", { oauth: true })).toBe("claude-subscription");
    expect(
      hermesConnectionRefusal("anthropic", {
        connectionIssue: "api-key-required",
        oauth: true,
      }),
    ).toBe("claude-subscription");
  });

  it("refuses any other sign-in connection generically", () => {
    expect(hermesConnectionRefusal("xai", { oauth: true })).toBe("sign-in");
    expect(hermesConnectionRefusal("github-copilot", { oauth: true })).toBe("sign-in");
  });

  it("keeps the pass-through providers in the table and nothing else", () => {
    expect(isHermesPassThroughProvider("openai-compatible")).toBe(true);
    expect(isHermesPassThroughProvider("ollama")).toBe(true);
    expect(isHermesPassThroughProvider("anthropic")).toBe(false);
    expect(HERMES_CONNECTION_POLICY.passThroughProviders).toEqual(["openai-compatible", "ollama"]);
  });

  it("returns the table sentence for every refusal id", () => {
    const sentences: Record<HermesConnectionRefusal, string> =
      HERMES_CONNECTION_POLICY.refusalSentences;
    expect(sentences["claude-subscription"]).toBe(
      "Claude subscriptions only work in Anthropic's own apps; add an Anthropic API key to use Claude with Hermes.",
    );
    expect(sentences["chatgpt-sign-in"]).toBe(
      "ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes.",
    );
    expect(sentences["sign-in"]).toBe(
      "Add an API key connection to use this provider with Hermes.",
    );
  });
});
