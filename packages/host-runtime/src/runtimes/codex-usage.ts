import type { AgentRuntimeEvent, RawUsageCounts, UsageOutcome } from "@ardurbot/adapter-kit";
import { normalizeUsageCounts, RequestUsageCollector, usageEvent } from "@ardurbot/adapter-kit";

/** App-server total counters cover a thread, including its internal requests and compaction. */
export function codexUsageCounts(value: unknown) {
  const usage = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return normalizeUsageCounts(
    {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cachedInputTokens,
      cacheWrite: usage.cacheWriteInputTokens,
      reasoning: usage.reasoningOutputTokens,
      total: usage.totalTokens,
    },
    "total-with-cache-subsets",
  );
}

/** Never uses `last` as spend or treats a decreasing total as a verified reset. */
export class CodexUsageCollector {
  private readonly collector: RequestUsageCollector;
  private baseline: RawUsageCounts | null;
  private latest: RawUsageCounts | null = null;
  private discontinuity = false;
  private fingerprint = "";
  constructor(provider: string, model: string, resumed: boolean) {
    this.baseline = resumed
      ? null
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
    this.collector = new RequestUsageCollector({
      provider,
      model,
      mappingVersion: "codex-thread-difference-v1",
      scope: "native-turn",
      inputSemantics: "total-with-cache-subsets",
      limitations: ["native-request-detail-unavailable"],
    });
  }
  seed(value: unknown) {
    const mapped = codexUsageCounts(value);
    if (!mapped.invalid && mapped.raw.input !== undefined && mapped.raw.output !== undefined)
      this.baseline = mapped.raw;
  }
  start() {
    if (!this.baseline) this.collector.limit("unverified-resume-boundary");
    return usageEvent(this.collector.start(this.baseline ?? undefined));
  }
  update(value: unknown): AgentRuntimeEvent | null {
    const mapped = codexUsageCounts(value);
    if (mapped.invalid || mapped.raw.input === undefined || mapped.raw.output === undefined) {
      this.collector.limit("invalid-provider-usage");
      return null;
    }
    if (!this.baseline || this.discontinuity) return null;
    const prior = this.latest ?? this.baseline;
    if (
      Object.entries(mapped.raw).some(
        ([key, value]) =>
          prior[key as keyof RawUsageCounts] !== undefined &&
          value < prior[key as keyof RawUsageCounts]!,
      )
    ) {
      this.discontinuity = true;
      this.collector.limit("counter-discontinuity");
      return null;
    }
    const fingerprint = JSON.stringify(mapped.raw);
    if (fingerprint === this.fingerprint) return null;
    this.fingerprint = fingerprint;
    const delta: RawUsageCounts = {};
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "reasoning",
      "total",
    ] as const) {
      if (mapped.raw[key] !== undefined && this.baseline[key] !== undefined)
        delta[key] = mapped.raw[key]! - this.baseline[key]!;
    }
    // Keep high-water marks through a partial notification to detect later resets.
    this.latest = { ...prior, ...mapped.raw };
    return usageEvent(this.collector.snapshot(delta, mapped.raw));
  }
  finish(outcome: Exclude<UsageOutcome, "started">, boundaryVerified = true) {
    if (!boundaryVerified) this.collector.limit("late-usage-unverified");
    return usageEvent(this.collector.finish(outcome));
  }
}
