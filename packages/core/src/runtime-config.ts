import type {
  HermesRuntimeConfigV1,
  HermesRuntimeConfigV2,
  HistoricalHermesRuntimeConfig,
} from "@ardurbot/contracts/runtime-config";
import {
  HERMES_RUNTIME_V1_DEFAULTS,
  HERMES_RUNTIME_V2_DEFAULTS,
  HermesRuntimeConfigV1Schema,
  HermesRuntimeConfigV2DraftSchema,
  HermesRuntimeConfigV2Schema,
} from "@ardurbot/contracts/runtime-config";

export function normalizeHermesRuntimeConfig(value: unknown): HermesRuntimeConfigV2 {
  const draft = HermesRuntimeConfigV2DraftSchema.parse(value);
  return HermesRuntimeConfigV2Schema.parse({
    version: 2,
    runtimeKind: "hermes",
    limits: {
      maxProviderRequests:
        draft.limits?.maxProviderRequests ?? HERMES_RUNTIME_V2_DEFAULTS.limits.maxProviderRequests,
      timeoutMs: draft.limits?.timeoutMs ?? HERMES_RUNTIME_V2_DEFAULTS.limits.timeoutMs,
    },
    context: {
      maxInputBytes:
        draft.context?.maxInputBytes ?? HERMES_RUNTIME_V2_DEFAULTS.context.maxInputBytes,
      overflow: draft.context?.overflow ?? HERMES_RUNTIME_V2_DEFAULTS.context.overflow,
    },
    harness: {
      agent: {
        api_max_retries:
          draft.harness?.agent?.api_max_retries ??
          HERMES_RUNTIME_V2_DEFAULTS.harness.agent.api_max_retries,
      },
    },
  });
}

export function decodeHistoricalHermesRuntimeConfig(value: unknown): HistoricalHermesRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid runtime configuration.");
  const version = (value as { version?: unknown }).version;
  if (version === 1) return HermesRuntimeConfigV1Schema.parse(value);
  if (version === 2) return HermesRuntimeConfigV2Schema.parse(value);
  throw new Error("Unsupported runtime configuration version.");
}

export function migrateHermesRuntimeConfig(value: unknown): HermesRuntimeConfigV2 {
  const historical = decodeHistoricalHermesRuntimeConfig(value);
  if (historical.version === 2) return historical;
  return normalizeHermesRuntimeConfig({
    version: 2,
    runtimeKind: "hermes",
    limits: {
      maxProviderRequests: historical.maxProviderRequests,
      timeoutMs: historical.timeoutMs,
    },
  });
}

export function effectiveHermesRuntimeConfigV2(value: unknown): HermesRuntimeConfigV2 {
  return value == null
    ? normalizeHermesRuntimeConfig(HERMES_RUNTIME_V2_DEFAULTS)
    : migrateHermesRuntimeConfig(value);
}

export function historicalHermesRuntimeDefaults(): HermesRuntimeConfigV1 {
  return { ...HERMES_RUNTIME_V1_DEFAULTS };
}

/** Canonical JSON is independent of object insertion order and rejects non-JSON values. */
export function canonicalRuntimeJson(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(object[key])}`)
        .join(",")}}`;
    }
    throw new Error("Runtime configuration contains a non-JSON value.");
  };
  return encode(value);
}
