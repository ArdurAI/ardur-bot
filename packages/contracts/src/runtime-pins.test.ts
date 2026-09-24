import { describe, expect, it } from "vitest";
import { ProductEventSchema } from "./events.js";
import { RunFailurePayloadSchema } from "./provider-errors.js";
import { RuntimePinSchema, runtimePinMessage, runtimePinProblem } from "./runtime-pins.js";

const pin = {
  provider: "local",
  modelId: "model",
  effort: "high",
  credentialId: "connection",
  runtimeKind: "pi" as const,
  revision: 2,
};
describe("runtime pin contracts", () => {
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
