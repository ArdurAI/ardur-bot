import {
  HERMES_RUNTIME_V1_DEFAULTS,
  HERMES_RUNTIME_V2_DEFAULTS,
} from "@ardurbot/contracts/runtime-config";
import { describe, expect, it } from "vitest";
import {
  effectiveRuntimeConfigHash,
  legacyHermesRuntimeConfigHash,
  runtimeConfigV2Hash,
} from "./node/runtime-config-hash.js";
import {
  canonicalRuntimeJson,
  decodeHistoricalHermesRuntimeConfig,
  migrateHermesRuntimeConfig,
  normalizeHermesRuntimeConfig,
} from "./runtime-config.js";

describe("Hermes configuration migration and identity", () => {
  it("migrates v1 without changing its selected limits", () => {
    expect(migrateHermesRuntimeConfig(HERMES_RUNTIME_V1_DEFAULTS)).toEqual(
      HERMES_RUNTIME_V2_DEFAULTS,
    );
    expect(
      migrateHermesRuntimeConfig({ version: 1, maxProviderRequests: 2, timeoutMs: 5_000 }).limits,
    ).toEqual({ maxProviderRequests: 2, timeoutMs: 5_000 });
    expect(normalizeHermesRuntimeConfig({ version: 2, runtimeKind: "hermes" })).toEqual(
      HERMES_RUNTIME_V2_DEFAULTS,
    );
    expect(() => decodeHistoricalHermesRuntimeConfig({ version: 3 })).toThrow();
    expect(() =>
      decodeHistoricalHermesRuntimeConfig({
        version: 1,
        maxProviderRequests: 16,
        timeoutMs: 180_000,
        env: "x",
      }),
    ).toThrow();
  });

  it("uses the frozen legacy array hash and distinct domain-separated v2 hashes", () => {
    expect(legacyHermesRuntimeConfigHash(HERMES_RUNTIME_V1_DEFAULTS)).toBe(
      "d95176f76ac26adeabd693c602e0b5988ffe7e0ea8d29809c2d90c90b84d617f",
    );
    const normalized = normalizeHermesRuntimeConfig({ version: 2, runtimeKind: "hermes" });
    expect(runtimeConfigV2Hash(normalized)).toBe(
      "6f1dfcf5a34ffc81b935c1300bfb1302200bd663b478d269cde5421659e357d1",
    );
    expect(
      runtimeConfigV2Hash({
        ...normalized,
        limits: { timeoutMs: 180_000, maxProviderRequests: 16 },
      }),
    ).toBe(runtimeConfigV2Hash(normalized));
    expect(
      runtimeConfigV2Hash({ ...normalized, context: { ...normalized.context, overflow: "stop" } }),
    ).not.toBe(runtimeConfigV2Hash(normalized));
    expect(effectiveRuntimeConfigHash({ profile: "one", settings: normalized })).toBe(
      "1664b9582918ebb318c84c18729ee63c51be369afd5e29a1a1b785556060fb6a",
    );
    expect(effectiveRuntimeConfigHash({ settings: normalized, profile: "two" })).not.toBe(
      effectiveRuntimeConfigHash({ profile: "one", settings: normalized }),
    );
  });

  it("sorts object keys, preserves array order and rejects non-JSON values", () => {
    expect(canonicalRuntimeJson({ b: [1, 2], a: true })).toBe('{"a":true,"b":[1,2]}');
    expect(canonicalRuntimeJson([2, 1])).not.toBe(canonicalRuntimeJson([1, 2]));
    for (const value of [undefined, NaN, Infinity, { missing: undefined }, new Date()])
      expect(() => canonicalRuntimeJson(value)).toThrow();
  });
});
