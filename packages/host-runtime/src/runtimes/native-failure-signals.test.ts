import type { RuntimeKind, RuntimePin } from "@ardurbot/contracts/runtime-pins";
import { describe, expect, it } from "vitest";
import { nativeFailureCategory, nativeFailureProblem } from "./native-failure-signals.js";

const pin = (runtimeKind: RuntimeKind): RuntimePin => ({
  runtimeKind,
  provider: "fixture-connection",
  modelId: "fixture-model",
  effort: "high",
  credentialId: "fixture-credential",
  revision: 1,
});

describe("native limit attribution", () => {
  it.each([
    "HTTP 429: rate limit exceeded, usage limit reached",
    "HTTP 429",
    "HTTP error 429",
    "status code: 429",
    "usage_limit_reached",
    "out of extra usage",
    "rate_limit_exceeded",
    "Too many requests",
    "quota exceeded",
    "insufficient_quota",
  ])("names the model connection for Hermes's provider refusal: %s", (detail) => {
    const category = nativeFailureCategory(detail, "hermes");
    expect(category).toBe("provider-rate-limit");
    const problem = nativeFailureProblem(pin("hermes"), category!);
    expect(problem).toMatchObject({
      reasonId: "provider-rate-limit",
      reason:
        "fixture-connection is refusing requests right now (rate or usage limit). Try again later or check your plan.",
      actions: ["retry"],
    });
    expect(problem.reason).not.toContain("Hermes's usage limit");
    expect(problem.reason).not.toContain(detail);
  });

  it.each([
    ["claude-code", "Claude Code", "out of extra usage"],
    ["claude-code", "Claude Code", "usage limit reached"],
    ["codex-app-server", "Codex", "usage_limit_reached"],
    ["codex-app-server", "Codex", "rate limit exceeded"],
  ] as const)("keeps genuine %s subscription limits on the runtime", (kind, name, detail) => {
    const category = nativeFailureCategory(detail, kind);
    expect(category).toBe("usage-limit");
    expect(nativeFailureProblem(pin(kind), category!)).toMatchObject({
      reasonId: "usage-limit",
      reason: `${name}'s usage limit is reached. Try again after it resets.`,
      actions: ["retry"],
    });
  });

  it.each([
    ["HTTP 401: invalid api key", "signed-out"],
    ["model fixture-model is not available", "model-unavailable"],
    ["upstream socket reset", undefined],
    ["429 tokens remain", undefined],
  ] as const)("preserves other Hermes failure signals: %s", (detail, category) => {
    expect(nativeFailureCategory(detail, "hermes")).toBe(category);
  });
});
