import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { nameHermesProviderFailure } from "./hermes-provider-problem.js";

const pin = {
  runtimeKind: "hermes",
  provider: "zai-coding-cn",
  modelId: "glm-5.3",
  effort: "high",
  credentialId: "fixture",
  revision: 1,
} as const;
it("uses the catalog name for local and paired host failures without changing their pin or actions", () => {
  const original = new RuntimePinError(
    runtimePinProblem(pin, "runtime-unavailable", "host sentence", "provider-rate-limit"),
  );
  original.cause = { kind: "provider-http", status: 429 };
  const named = nameHermesProviderFailure(original) as RuntimePinError;
  expect(named.problem.reason).toBe(
    "Z.AI Coding CN is refusing requests right now (rate or usage limit). Try again later or check your plan.",
  );
  expect(named.problem.pin).toEqual(original.problem.pin);
  expect(named.problem.actions).toEqual(original.problem.actions);
  expect(named.cause).toBe(original.cause);
  expect(original.problem.reason).toBe("host sentence");
});
it.each(["provider-grant-refused", "provider-request-too-large", "usage-limit"])(
  "keeps refusal %s unchanged",
  (reasonId) => {
    const error = new RuntimePinError(
      runtimePinProblem(pin, "runtime-unavailable", "recorded", reasonId),
    );
    expect(nameHermesProviderFailure(error)).toBe(error);
  },
);
it("keeps unknown failures unchanged", () => {
  const error = new Error("private fixture");
  expect(nameHermesProviderFailure(error)).toBe(error);
});
it("keeps an unknown provider id rather than inventing a catalog label", () => {
  const error = new RuntimePinError(
    runtimePinProblem(
      { ...pin, provider: "fixture" },
      "runtime-unavailable",
      "recorded",
      "provider-rate-limit",
    ),
  );
  expect((nameHermesProviderFailure(error) as RuntimePinError).problem.reason).toContain(
    "fixture is refusing requests",
  );
});
