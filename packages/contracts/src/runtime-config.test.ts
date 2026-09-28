import { describe, expect, it } from "vitest";
import {
  HERMES_RUNTIME_V2_DEFAULTS,
  HermesExecutionEnvelopeSchema,
  HermesRuntimeConfigV1Schema,
  HermesRuntimeConfigV2DraftSchema,
  HermesRuntimeConfigV2Schema,
} from "./runtime-config.js";

describe("versioned runtime configuration", () => {
  it("retains the historical shape and accepts only the expanded version 2 shape", () => {
    expect(
      HermesRuntimeConfigV1Schema.safeParse({
        version: 1,
        maxProviderRequests: 16,
        timeoutMs: 180_000,
      }).success,
    ).toBe(true);
    expect(HermesRuntimeConfigV2Schema.parse(HERMES_RUNTIME_V2_DEFAULTS)).toEqual(
      HERMES_RUNTIME_V2_DEFAULTS,
    );
    expect(HermesRuntimeConfigV2DraftSchema.parse({ version: 2, runtimeKind: "hermes" })).toEqual({
      version: 2,
      runtimeKind: "hermes",
    });
    expect(
      HermesRuntimeConfigV2Schema.safeParse({ version: 2, runtimeKind: "hermes" }).success,
    ).toBe(false);
    expect(
      HermesRuntimeConfigV2Schema.safeParse({ ...HERMES_RUNTIME_V2_DEFAULTS, model: "other" })
        .success,
    ).toBe(false);
  });

  it("requires a compiled manifest for execution envelopes", () => {
    expect(
      HermesExecutionEnvelopeSchema.safeParse({
        runtimeKind: "hermes",
        runtimeConfig: HERMES_RUNTIME_V2_DEFAULTS,
        runtimeConfigHash: "a".repeat(64),
      }).success,
    ).toBe(false);
  });
});
