import { createHash } from "node:crypto";
import type {
  HermesRuntimeConfigV1,
  HermesRuntimeConfigV2,
} from "@ardurbot/contracts/runtime-config";
import {
  HermesExecutionEnvelopeSchema,
  HermesRuntimeConfigV1Schema,
} from "@ardurbot/contracts/runtime-config";
import { canonicalRuntimeJson, normalizeHermesRuntimeConfig } from "../runtime-config.js";

export function legacyHermesRuntimeConfigHash(config: HermesRuntimeConfigV1): string {
  const value = HermesRuntimeConfigV1Schema.parse(config);
  return createHash("sha256")
    .update(JSON.stringify([value.version, value.maxProviderRequests, value.timeoutMs]))
    .digest("hex");
}

export function runtimeConfigV2Hash(config: HermesRuntimeConfigV2): string {
  return createHash("sha256")
    .update("ardur:runtime-config:v2\n", "utf8")
    .update(canonicalRuntimeJson(normalizeHermesRuntimeConfig(config)), "utf8")
    .digest("hex");
}

export function effectiveRuntimeConfigHash(manifest: unknown): string {
  return createHash("sha256")
    .update("ardur:effective-runtime-config:v1\n", "utf8")
    .update(canonicalRuntimeJson(manifest), "utf8")
    .digest("hex");
}

/** Structural and hash gate for captured B12 records; the host also recompiles the policy. */
export function validateHermesExecutionEnvelope(value: unknown) {
  const envelope = HermesExecutionEnvelopeSchema.parse(value);
  if (
    canonicalRuntimeJson(envelope.runtimeConfig) !==
      canonicalRuntimeJson(envelope.effectiveRuntimeConfig.settings) ||
    envelope.runtimeConfigHash !== runtimeConfigV2Hash(envelope.runtimeConfig) ||
    envelope.effectiveRuntimeConfigHash !==
      effectiveRuntimeConfigHash(envelope.effectiveRuntimeConfig)
  )
    throw new Error("Runtime configuration identity does not match its manifest.");
  return envelope;
}
