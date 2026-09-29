import { describe, expect, it } from "vitest";
import { hermesConnectionRefusal } from "./hermes-connections.js";

describe("hermesConnectionRefusal", () => {
  it("allows custom endpoints and an unselected provider", () => {
    expect(hermesConnectionRefusal(undefined)).toBeUndefined();
    expect(hermesConnectionRefusal(null)).toBeUndefined();
    expect(hermesConnectionRefusal("openai-compatible")).toBeUndefined();
    expect(hermesConnectionRefusal("ollama")).toBeUndefined();
  });

  it("allows key-based catalog connections", () => {
    expect(hermesConnectionRefusal("anthropic")).toBeUndefined();
    expect(hermesConnectionRefusal("google")).toBeUndefined();
    expect(hermesConnectionRefusal("openai")).toBeUndefined();
    expect(hermesConnectionRefusal("openrouter")).toBeUndefined();
    expect(hermesConnectionRefusal("kimi-coding")).toBeUndefined();
    expect(hermesConnectionRefusal("zai")).toBeUndefined();
    expect(hermesConnectionRefusal("xai", { oauth: false })).toBeUndefined();
  });

  it("refuses a ChatGPT sign-in regardless of credential detail", () => {
    expect(hermesConnectionRefusal("openai-codex")).toBe("chatgpt-sign-in");
    expect(hermesConnectionRefusal("openai-codex", { oauth: true })).toBe("chatgpt-sign-in");
  });

  it("refuses a Claude subscription from the connection issue or OAuth marker", () => {
    expect(hermesConnectionRefusal("anthropic", { connectionIssue: "api-key-required" })).toBe(
      "claude-subscription",
    );
    expect(hermesConnectionRefusal("anthropic", { oauth: true })).toBe("claude-subscription");
  });

  it("refuses any other sign-in connection generically", () => {
    expect(hermesConnectionRefusal("xai", { oauth: true })).toBe("sign-in");
    expect(hermesConnectionRefusal("github-copilot", { oauth: true })).toBe("sign-in");
  });
});
