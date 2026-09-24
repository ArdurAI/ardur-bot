import { runtimePinMessage, runtimePinProblem } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { runtimePinRecovery } from "./runtime-pin-recovery";

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
    connect: { pathname: "/models", params: { provider: "xai" } },
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
