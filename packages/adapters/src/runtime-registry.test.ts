import type { AgentRuntime } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { RuntimeRegistry } from "./runtime-registry.js";

const pin: RuntimePin = {
  runtimeKind: "hermes",
  provider: "openai-compatible",
  modelId: "same-model",
  effort: "off",
  credentialId: "connection-one",
  revision: 1,
};
const connection = {
  credentialId: "connection-one",
  provider: "openai-compatible",
  modelId: "same-model",
  effort: "off",
};

describe("Hermes registry admission", () => {
  const make = (available: boolean) => {
    const runtime = {} as AgentRuntime;
    const factory = vi.fn(() => runtime);
    const probe = vi.fn(async () => ({
      runtimeKind: "hermes" as const,
      available,
      models: [],
      reason: available ? undefined : "Hermes is not installed on this computer.",
    }));
    return {
      runtime,
      factory,
      probe,
      registry: new RuntimeRegistry({ hermes: { factory, probe } }),
    };
  };

  it("matches the full connection, model, and effort without another runtime fallback", async () => {
    const f = make(true);
    expect(await f.registry.resolve(pin, "desktop", true, connection)).toMatchObject({
      runtime: f.runtime,
    });
    expect(
      await f.registry.resolve(pin, "desktop", true, {
        ...connection,
        credentialId: "connection-two",
      }),
    ).toMatchObject({ code: "pin-credential-missing" });
    expect(f.factory).toHaveBeenCalledOnce();
  });

  it("fails closed for a missing install, unsupported computer, and disabled experiment", async () => {
    const f = make(false);
    expect(await f.registry.resolve(pin, "desktop", true, connection)).toMatchObject({
      code: "runtime-unavailable",
    });
    expect(await f.registry.resolve(pin, "docker", true, connection)).toMatchObject({
      code: "runtime-unsupported-computer",
    });
    expect(await f.registry.resolve(pin, "desktop", false, connection)).toMatchObject({
      code: "runtime-unavailable",
    });
    expect(f.factory).not.toHaveBeenCalled();
  });
});
