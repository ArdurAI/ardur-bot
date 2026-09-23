import { runtimePinMessage, runtimePinProblem } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { runtimePinRecovery } from "./runtime-pin-recovery";

it("shows the pin and directs recovery to its provider and failed bot", () => {
  const pin = {
    provider: "xai",
    modelId: "grok-4.6",
    effort: "high",
    credentialId: "deleted",
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
