import { contentDigest } from "../manifest.js";

export function seededRandom(seed: number) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid seed");
  let value = seed;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export const STREAM_SCENARIOS = [
  "one-byte",
  "burst",
  "long-gap",
  "split-unicode",
  "split-secret",
  "short-final-delta",
  "slow-database",
  "slow-renderer",
] as const;
export type StreamScenario = (typeof STREAM_SCENARIOS)[number];
export const SYNTHETIC_SECRET = "synthetic-matrix-secret-canary";
export const STREAM_TEXT = `First café 🧪. ${SYNTHETIC_SECRET} Final.`;

/** Fragment bytes, not JS characters: this exercises incremental UTF-8 transport decoding. */
export function streamSchedule(scenario: StreamScenario, text = STREAM_TEXT) {
  if (!STREAM_SCENARIOS.includes(scenario)) throw new Error("Unknown streaming scenario");
  const bytes = Buffer.from(text);
  const size =
    scenario === "burst" ? 64 : scenario === "one-byte" || scenario === "split-unicode" ? 1 : 7;
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => ({
    bytes: bytes.subarray(index * size, (index + 1) * size),
    delayMs:
      scenario === "long-gap" && index === 1
        ? 300
        : scenario === "short-final-delta" && index === Math.ceil(bytes.length / size) - 1
          ? 300
          : 0,
  }));
}

export const RATE_SCENARIOS = [
  "429-reset",
  "retry-after-zero",
  "retry-after-malformed",
  "5xx",
  "disconnect",
  "authentication-failure",
  "quota-exhaustion",
] as const;
export type RateScenario = (typeof RATE_SCENARIOS)[number];

export function rateSchedule(scenario: RateScenario, seed: number) {
  if (!RATE_SCENARIOS.includes(scenario)) throw new Error("Unknown failure scenario");
  const random = seededRandom(seed);
  const status = scenario === "authentication-failure" ? 401 : scenario === "5xx" ? 503 : 429;
  const headers: Record<string, string> =
    scenario === "retry-after-zero"
      ? { "retry-after": "0" }
      : scenario === "retry-after-malformed"
        ? { "retry-after": "not-a-number" }
        : scenario === "429-reset"
          ? { "retry-after": "1", "x-ratelimit-reset-requests": "1s" }
          : {};
  return {
    scenario,
    status,
    headers,
    code:
      scenario === "quota-exhaustion"
        ? "insufficient_quota"
        : scenario === "authentication-failure"
          ? "invalid_api_key"
          : "rate_limit_exceeded",
    // Jitter belongs to the offered fault schedule, never a replacement production retry policy.
    jitterMs: Array.from({ length: 8 }, () => Math.floor(random() * 11)),
    disconnect: scenario === "disconnect",
    maxObservedAttempts: 8,
  };
}

export const GOLD_PROBES = {
  fact: "Budget is 120 units.",
  negation: "Do not send the draft.",
  supersession: "Revision 3 supersedes revision 2.",
  approval: "Payment approval is pending.",
  unresolved: "The tax discrepancy is unresolved.",
  source: "Source: policy.md@3.",
} as const;
export const GOLD_SUMMARY = JSON.stringify(GOLD_PROBES);

/** A structured gold oracle; arbitrary prose and keyword overlap cannot certify recall. */
export function gradeGoldProbes(summary: string) {
  let actual: unknown;
  try {
    actual = JSON.parse(summary);
  } catch {
    actual = null;
  }
  return Object.fromEntries(
    Object.entries(GOLD_PROBES).map(([key, value]) => [
      key,
      Boolean(
        actual && typeof actual === "object" && key in actual && Reflect.get(actual, key) === value,
      ),
    ]),
  );
}

export function prefixObservation(requests: readonly unknown[]) {
  return {
    hashes: requests.map(contentDigest),
    actualProviderCacheHit: null,
    provenance: "serialized-request; eligibility-only",
  };
}
