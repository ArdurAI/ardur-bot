import { describe, expect, it } from "vitest";
import {
  HERMES_RUNTIME_DEFAULTS,
  HermesRuntimeConfigSchema,
  RuntimePinSchema,
} from "./runtime-pins.js";

describe("Hermes runtime limits", () => {
  it("uses the versioned defaults and strict request and time bounds", () => {
    expect(HERMES_RUNTIME_DEFAULTS).toEqual({
      version: 1,
      maxProviderRequests: 16,
      timeoutMs: 180_000,
    });
    expect(
      HermesRuntimeConfigSchema.parse({ version: 1, maxProviderRequests: 1, timeoutMs: 1_000 }),
    ).toBeTruthy();
    expect(
      HermesRuntimeConfigSchema.parse({ version: 1, maxProviderRequests: 64, timeoutMs: 600_000 }),
    ).toBeTruthy();
    for (const value of [
      { version: 2, maxProviderRequests: 16, timeoutMs: 180_000 },
      { version: 1, maxProviderRequests: 0, timeoutMs: 180_000 },
      { version: 1, maxProviderRequests: 65, timeoutMs: 180_000 },
      { version: 1, maxProviderRequests: 16, timeoutMs: 999 },
      { version: 1, maxProviderRequests: 16, timeoutMs: 600_001 },
      { version: 1, maxProviderRequests: 16, timeoutMs: 1_500 },
      { version: 1, maxProviderRequests: 16, timeoutMs: 180_000, env: "unsafe" },
    ])
      expect(HermesRuntimeConfigSchema.safeParse(value).success).toBe(false);
  });

  it("accepts old pin JSON while carrying effective limits for new Hermes runs", () => {
    const base = {
      runtimeKind: "hermes",
      provider: "openai-compatible",
      modelId: "fixture",
      effort: "off",
      credentialId: "connected",
      revision: 1,
    };
    expect(RuntimePinSchema.parse(base).runtimeConfig).toBeUndefined();
    expect(
      RuntimePinSchema.parse({
        ...base,
        runtimeConfig: HERMES_RUNTIME_DEFAULTS,
        runtimeConfigHash: "a".repeat(64),
      }),
    ).toMatchObject({ runtimeConfig: HERMES_RUNTIME_DEFAULTS });
  });
});
