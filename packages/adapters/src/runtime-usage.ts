import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeEvent,
  AgentUsage,
  RequestUsageObservation,
  UsageOutcome,
  UsagePurpose,
} from "@ardurbot/adapter-kit";
import { RequestUsageCollector, unknownUsageCategories } from "@ardurbot/adapter-kit";
import type { RequestUsageTotals } from "./request-usage.js";
import { accumulateRequestUsage, parseRequestUsage, usageTokenTotals } from "./request-usage.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
const keyOf = (event: AgentUsage & { delegationId?: string }) =>
  JSON.stringify([
    event.delegationId,
    event.request?.requestId,
    event.request?.attemptId,
    event.request?.counter.epochId,
  ]);

/** Uses the ledger's arithmetic for local spend; identity-free legacy events remain deltas. */
export class ObservedUsageTotals {
  private rows = new Map<string, { totals: RequestUsageTotals; receipts: Map<number, string> }>();
  tokens = 0;
  reported = false;
  /** Newly measured spend, or null for an unavailable or already counted observation. */
  observe(
    usage: AgentUsage & { delegationId?: string },
  ): Pick<AgentUsage, "inputTokens" | "outputTokens"> | null {
    if (!usage.request) {
      if (usage.reported === false) return null;
      if (
        ![usage.inputTokens, usage.outputTokens].every(
          (value) => Number.isInteger(value) && value >= 0 && value <= 2_147_483_647,
        )
      )
        throw new Error("Invalid legacy usage totals");
      this.tokens += usage.inputTokens + usage.outputTokens;
      this.reported = true;
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    }
    const request = parseRequestUsage(usage.request);
    const key = keyOf(usage);
    const previous = this.rows.get(key);
    const fingerprint = JSON.stringify(request);
    const receipt = previous?.receipts.get(request.counter.sequence);
    if (receipt !== undefined) {
      if (receipt !== fingerprint) throw new Error("Conflicting usage observation replay");
      return null;
    }
    const totals = accumulateRequestUsage(previous?.totals ?? null, request);
    const prior = previous
      ? usageTokenTotals(previous.totals.categories, request.reasoningSemantics)
      : { inputTokens: 0, outputTokens: 0 };
    const next = usageTokenTotals(totals.categories, request.reasoningSemantics);
    const delta = {
      inputTokens: next.inputTokens - prior.inputTokens,
      outputTokens: next.outputTokens - prior.outputTokens,
    };
    const reported = request.categories.logicalInput !== null || request.categories.output !== null;
    const previouslyReported =
      previous?.totals.categories.logicalInput != null ||
      previous?.totals.categories.output != null;
    this.tokens += delta.inputTokens + delta.outputTokens;
    this.reported ||= reported;
    const receipts = previous?.receipts ?? new Map<number, string>();
    receipts.set(request.counter.sequence, fingerprint);
    this.rows.set(key, { totals, receipts });
    return delta.inputTokens || delta.outputTokens || (reported && !previouslyReported)
      ? delta
      : null;
  }
}

/** Persist usage before consumer cancellation/fences can skip a streamed event. */
export async function* accountRuntimeUsage(
  events: AsyncIterable<AgentRuntimeEvent>,
  options: {
    provider: string;
    model: string;
    purpose?: UsagePurpose;
    signal?: AbortSignal;
    record: (usage: UsageEvent) => Promise<void>;
    totals?: ObservedUsageTotals;
  },
): AsyncGenerator<AgentRuntimeEvent> {
  const pending = new Map<string, UsageEvent>();
  const fallback = new RequestUsageCollector({
    provider: options.provider,
    model: options.model,
    mappingVersion: "runtime-call-v1",
    inputSemantics: "unknown",
    reasoningSemantics: "unknown",
    scope: "runtime-call",
    purpose: options.purpose,
    limitations: ["transport-detail-unavailable"],
  });
  const legacyId = randomUUID();
  let legacySequence = 0;
  let observed = false;
  let exhausted = false;
  const iterator = events[Symbol.asyncIterator]();
  let outcome: Exclude<UsageOutcome, "started"> = "unknown";
  const persist = async (event: UsageEvent) => {
    await options.record(event);
    options.totals?.observe(event);
    const key = keyOf(event);
    if ((pending.get(key)?.request?.counter.sequence ?? -1) < event.request!.counter.sequence)
      pending.set(key, event);
    observed = true;
  };
  const recordUsage = async (event: UsageEvent) => {
    const request: RequestUsageObservation = event.request ?? {
      requestId: legacyId,
      attemptId: "0",
      parentRequestId: null,
      purpose: options.purpose ?? "main",
      counter: { mode: "delta", epochId: "0", sequence: legacySequence++ },
      inputSemantics: "unknown",
      reasoningSemantics: "unknown",
      categories: {
        ...unknownUsageCategories(),
        logicalInput: event.reported === false ? null : event.inputTokens,
        output: event.reported === false ? null : event.outputTokens,
      },
      cost: null,
      pricingProvenance: null,
      collection: {
        mappingVersion: "legacy-runtime-v1",
        scope: "runtime-call",
        outcome: "started",
        availability: event.reported === false ? "unavailable" : "partial",
        raw: {},
        limitations: ["transport-detail-unavailable"],
      },
    };
    const purpose =
      options.purpose && options.purpose !== "main"
        ? options.purpose === "delegated" && request.purpose !== "main"
          ? request.purpose
          : options.purpose
        : request.purpose;
    await persist({
      ...event,
      inputTokens: request.categories.logicalInput ?? 0,
      outputTokens: usageTokenTotals(request.categories, request.reasoningSemantics).outputTokens,
      request: { ...request, purpose },
    });
  };
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        exhausted = true;
        break;
      }
      const event = next.value;
      if (event.type === "usage") await recordUsage(event);
      else {
        if (event.type === "done") outcome = "success";
        yield event;
      }
    }
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    if (options.signal?.aborted) {
      outcome = options.signal.reason?.name === "TimeoutError" ? "timed-out" : "cancelled";
      // The enclosing cleanup aborts tool work first. Drain the cancelled runtime's
      // queued accounting without executing or releasing any further tool/text events.
      if (!exhausted) {
        try {
          while (true) {
            let next: IteratorResult<AgentRuntimeEvent>;
            try {
              next = await iterator.next();
            } catch {
              break;
            }
            if (next.done) {
              exhausted = true;
              break;
            }
            if (next.value.type === "usage") await recordUsage(next.value);
          }
        } finally {
          await iterator.return?.();
        }
      }
    } else if (!exhausted) await iterator.return?.();
    if (!observed) {
      await persist({ type: "usage", ...fallback.start() });
      await persist({ type: "usage", ...fallback.finish(outcome) });
    }
    for (const event of pending.values()) {
      const request = event.request!;
      if (request.collection?.outcome !== "started") continue;
      const delta = request.counter.mode === "delta";
      const finalRequest: RequestUsageObservation = {
        ...request,
        counter: { ...request.counter, sequence: request.counter.sequence + 1 },
        ...(delta
          ? { categories: unknownUsageCategories(), cost: null, pricingProvenance: null }
          : {}),
        collection: {
          ...request.collection,
          outcome,
          availability:
            request.collection.availability === "unavailable" ? "unavailable" : "partial",
          limitations: [
            ...new Set([
              ...request.collection.limitations,
              exhausted ? ("stream-ended-without-usage" as const) : ("consumer-stopped" as const),
            ]),
          ],
        },
      };
      await options.record({
        ...event,
        ...usageTokenTotals(finalRequest.categories, finalRequest.reasoningSemantics),
        request: finalRequest,
      });
    }
  }
}
