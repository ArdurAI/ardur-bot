import type { AgentRuntime } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import { RuntimePinSchema } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { requestedBotPin } from "./pin-resolution.js";
import { RuntimeRegistry } from "./runtime-registry.js";

const pin: RuntimePin = {
  runtimeKind: "claude-code",
  provider: "anthropic",
  modelId: "model",
  effort: "low",
  credentialId: "native:claude-code",
  revision: 1,
};
describe("runtime pin selection", () => {
  it("defaults only absent legacy runtime kinds to pi", () => {
    expect(requestedBotPin({}).runtimeKind).toBe("pi");
    const { runtimeKind: _, ...legacy } = pin;
    expect(RuntimePinSchema.parse(legacy).runtimeKind).toBe("pi");
    expect(RuntimePinSchema.safeParse({ ...pin, runtimeKind: "missing" }).success).toBe(false);
  });
  it("selects only the factory bound to the saved kind", async () => {
    const runtime = {} as AgentRuntime;
    const pi = vi.fn();
    const native = vi.fn(() => runtime);
    const registry = new RuntimeRegistry({
      pi: { factory: pi, probe: vi.fn() },
      "claude-code": {
        factory: native,
        probe: async () => ({
          runtimeKind: "claude-code",
          available: true,
          version: "2.1.281",
          models: [{ id: "model", label: "Model", efforts: ["low"] }],
        }),
      },
    });
    expect(await registry.resolve(pin, "desktop", true)).toMatchObject({
      runtime,
      availability: { version: "2.1.281" },
    });
    expect(await registry.resolve(pin, "desktop")).toMatchObject({
      code: "runtime-unavailable",
      reason: expect.stringContaining("experimental"),
    });
    expect(native).toHaveBeenCalledOnce();
    expect(pi).not.toHaveBeenCalled();
    expect(await registry.resolve({ ...pin, effort: "max" }, "desktop", true)).toMatchObject({
      code: "pin-effort-unsupported",
    });
    expect(await registry.resolve({ ...pin, modelId: "other" }, "desktop", true)).toMatchObject({
      code: "pin-model-unknown",
    });
  });
  it("fails before a probe or effect for containers and never replaces an unavailable runtime", async () => {
    const probe = vi.fn(async () => ({
      runtimeKind: "claude-code" as const,
      available: false,
      models: [],
      reason: "claude is not installed on this computer",
    }));
    const factory = vi.fn();
    const registry = new RuntimeRegistry({ "claude-code": { factory, probe } });
    expect(await registry.resolve(pin, "docker")).toMatchObject({
      code: "runtime-unsupported-computer",
      pin,
      reason:
        "Claude Code runs on host computers for now — change the bot's computer or its runtime.",
    });
    expect(probe).not.toHaveBeenCalled();
    expect(await registry.resolve(pin, "desktop", true)).toMatchObject({
      code: "runtime-unavailable",
      pin,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(await new RuntimeRegistry({}).resolve(pin, "desktop", true)).toMatchObject({
      code: "runtime-unavailable",
      pin,
    });
  });
});
