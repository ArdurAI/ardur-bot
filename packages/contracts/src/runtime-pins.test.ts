import { describe, expect, it } from "vitest";
import { ProductEventSchema } from "./events.js";
import { RunFailurePayloadSchema } from "./provider-errors.js";
import {
  RuntimeInfoSchema,
  RuntimePinError,
  RuntimePinSchema,
  runtimePinMessage,
  runtimePinProblem,
} from "./runtime-pins.js";

const pin = {
  provider: "local",
  modelId: "model",
  effort: "high",
  credentialId: "connection",
  runtimeKind: "pi" as const,
  revision: 2,
};
describe("runtime pin contracts", () => {
  it("round trips effort evidence while keeping older runtime info readable", () => {
    const info = {
      runtimeKind: "claude-code",
      effortAttested: false,
      effortAttestationReason: "Claude Code does not report the applied effort",
    };
    expect(RuntimeInfoSchema.parse(JSON.parse(JSON.stringify(info)))).toEqual(info);
    expect(RuntimeInfoSchema.parse({ runtimeKind: "claude-code" })).toEqual({
      runtimeKind: "claude-code",
    });
    expect(
      RuntimeInfoSchema.parse({ ...info, effortAttested: true, effortAttestationReason: null }),
    ).toMatchObject({ effortAttested: true, effortAttestationReason: null });
    expect(RuntimeInfoSchema.safeParse({ ...info, effortAttested: "false" }).success).toBe(false);
  });
  it("round trips a snapshot and a typed failure without secrets", () => {
    expect(RuntimePinSchema.parse(pin)).toEqual(pin);
    const problem = runtimePinProblem(pin, "pin-credential-missing", "The connection was deleted.");
    expect(RunFailurePayloadSchema.parse({ runtimeProblem: problem }).runtimeProblem).toEqual(
      problem,
    );
    expect(runtimePinMessage(pin, { provider: "Local", model: "My model" })).toBe(
      "This bot is pinned to Local · My model · high; connect it or change the pin.",
    );
  });
  it("validates typed failures even without the older provider error kind", () => {
    const event = {
      id: "event",
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      seq: 0,
      type: "run.failed",
      createdAt: "2026-09-23",
      payload: { runtimeProblem: { code: "invented" } },
    };
    expect(ProductEventSchema.safeParse(event).success).toBe(false);
    expect(ProductEventSchema.safeParse({ ...event, payload: { error: "legacy" } }).success).toBe(
      true,
    );
    expect(ProductEventSchema.safeParse({ ...event, payload: { error: null } }).success).toBe(true);
  });
  it("includes the native runtime in the preserved pin sentence", () => {
    expect(runtimePinMessage({ ...pin, runtimeKind: "claude-code" })).toContain(
      "pinned to Claude Code · local · model · high",
    );
  });
});

it("uses the real reason and offers Connect only for a hosted credential failure", () => {
  const native = {
    ...pin,
    runtimeKind: "codex-app-server" as const,
    credentialId: "native:codex-app-server",
  };
  for (const selected of [pin, native]) {
    const problem = runtimePinProblem(
      selected,
      "pin-model-unknown",
      "The pinned model is unavailable in this runtime.",
    );
    expect(new RuntimePinError(problem).message).toBe(problem.reason);
    expect(problem.actions).toEqual(["change-pin"]);
  }
  const missing = runtimePinProblem(pin, "pin-credential-missing", "Missing connection");
  expect(missing.actions).toEqual(["connect", "change-pin"]);
  expect(new RuntimePinError(missing).message).toContain("connect it or change the pin");
});
