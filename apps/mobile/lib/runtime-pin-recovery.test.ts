import { runtimePinMessage, runtimePinProblem } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { activateUiLocale } from "./i18n";
import { antigravityProblemMessage, runtimePinRecovery } from "./runtime-pin-recovery";

it("shows the pin and directs recovery to its provider and failed bot", () => {
  const pin = {
    provider: "xai",
    modelId: "grok-4.6",
    effort: "high",
    credentialId: "deleted",
    runtimeKind: "pi" as const,
    revision: 1,
  };
  const problem = runtimePinProblem(pin, "pin-credential-missing", "Missing connection");
  expect(runtimePinMessage(pin)).toBe(
    "This bot is pinned to xai · grok-4.6 · high; connect it or change the pin.",
  );
  expect(runtimePinRecovery(problem, "failed-group-member")).toEqual({
    connect: { pathname: "/models", params: { provider: "xai", botId: "failed-group-member" } },
    changePin: { pathname: "/bot-settings", params: { botId: "failed-group-member" } },
  });
});

it("routes native sign-in recovery to the failed bot runtime settings", () => {
  const problem = runtimePinProblem(
    {
      runtimeKind: "codex-app-server",
      provider: "openai-codex",
      modelId: "model",
      effort: "high",
      credentialId: "native:codex-app-server",
      revision: 1,
    },
    "runtime-unavailable",
    "Codex app-server unavailable",
  );
  expect(runtimePinRecovery(problem, "bot").connect).toEqual({
    pathname: "/bot-settings",
    params: { botId: "bot" },
  });
});

it("translates Antigravity model and tool failures", () => {
  const pin = {
    runtimeKind: "antigravity" as const,
    provider: "antigravity",
    modelId: "gemini-3.8-flash-low",
    effort: "low",
    credentialId: "native:antigravity",
    revision: 1,
  };
  activateUiLocale("zh-CN");
  try {
    expect(
      antigravityProblemMessage(runtimePinProblem(pin, "pin-model-unknown", "unrecognised")),
    ).toContain("无法识别模型 gemini-3.8-flash-low");
    expect(
      antigravityProblemMessage(
        runtimePinProblem(
          pin,
          "runtime-unavailable",
          "Antigravity tried to use its own tools, which Ardur does not allow yet. The turn was stopped.",
        ),
      ),
    ).toContain("已停止本轮运行");
  } finally {
    activateUiLocale("en");
  }
});
