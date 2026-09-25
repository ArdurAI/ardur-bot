import type { AgentRuntimeEvent, AgentUsage } from "@ardurbot/adapter-kit";
import { RequestUsageCollector, usageEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { accountRuntimeUsage, ObservedUsageTotals } from "./runtime-usage.js";

const collector = () =>
  new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const result: AgentRuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
describe("usage persistence around runtime streams", () => {
  it("returns only newly measured spend, preserving measured zero and legacy deltas", () => {
    const request = collector();
    const totals = new ObservedUsageTotals();
    expect(totals.observe(request.start())).toBeNull();
    expect(totals.reported).toBe(false);
    expect(totals.observe(request.snapshot({ input: 0, output: 0 }))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(totals.reported).toBe(true);
    const snapshot = request.snapshot({ input: 100, output: 30 });
    expect(totals.observe(snapshot)).toEqual({ inputTokens: 100, outputTokens: 30 });
    expect(totals.observe(request.finish("success"))).toBeNull();
    expect(totals.observe(snapshot)).toBeNull();
    expect(
      totals.observe({ provider: "fixture", model: "fixture", inputTokens: 10, outputTokens: 5 }),
    ).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(
      totals.observe({
        provider: "fixture",
        model: "fixture",
        inputTokens: 10,
        outputTokens: 5,
        reported: false,
      }),
    ).toBeNull();
    expect(totals.tokens).toBe(145);
  });

  it("preserves deltas from legacy runtimes without inventing request identity", () => {
    const totals = new ObservedUsageTotals();
    const usage = { provider: "fixture", model: "fixture", inputTokens: 100, outputTokens: 30 };
    totals.observe(usage);
    totals.observe(usage);
    expect(totals.tokens).toBe(260);
    expect(totals.reported).toBe(true);
    expect(() => totals.observe({ ...usage, inputTokens: -1 })).toThrow();
    expect(totals.tokens).toBe(260);
  });

  it("persists duplicate and cumulative delivery once in local spend totals", async () => {
    const request = collector();
    const started = request.start();
    const first = request.snapshot({ input: 100, output: 20, reasoning: 8 });
    const events: AgentRuntimeEvent[] = [
      usageEvent(started),
      usageEvent(first),
      usageEvent(first),
      usageEvent(request.snapshot({ input: 140, output: 30, reasoning: 10 })),
      usageEvent(request.finish("success")),
      { type: "done" },
    ];
    const totals = new ObservedUsageTotals();
    const record = vi.fn(async () => undefined);
    const stream = accountRuntimeUsage(
      (async function* () {
        yield* events;
      })(),
      { provider: "fixture", model: "fixture", record, totals },
    );
    expect(await collect(stream)).toEqual([{ type: "done" }]);
    expect(totals.tokens).toBe(170);
    expect(totals.reported).toBe(true);
    expect(record).toHaveBeenCalledTimes(5);
  });
  it("retains spent tokens and closes an unfinished request after failure", async () => {
    const request = collector();
    const records: AgentUsage[] = [];
    const stream = accountRuntimeUsage(
      (async function* () {
        yield usageEvent(request.start());
        yield usageEvent(request.snapshot({ input: 100, output: 20 }));
        throw new Error("fixture failure");
      })(),
      {
        provider: "fixture",
        model: "fixture",
        record: async (usage) => {
          records.push(usage);
        },
      },
    );
    await expect(collect(stream)).rejects.toThrow("fixture failure");
    expect(records.at(-1)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      request: { collection: { outcome: "failed" } },
    });
    const totals = new ObservedUsageTotals();
    for (const record of records) totals.observe(record);
    expect(totals.tokens).toBe(120);
  });
  it.each(["summary", "detached-learning", "delegated"] as const)(
    "attributes %s without changing runtime output",
    async (purpose) => {
      const records: AgentUsage[] = [];
      const stream = accountRuntimeUsage(
        (async function* () {
          yield {
            type: "usage",
            provider: "fixture",
            model: "fixture",
            inputTokens: 50,
            outputTokens: 5,
          } as const;
          yield { type: "done", text: "fixture" } as const;
        })(),
        {
          provider: "fixture",
          model: "fixture",
          purpose,
          record: async (usage) => {
            records.push(usage);
          },
        },
      );
      expect(await collect(stream)).toEqual([{ type: "done", text: "fixture" }]);
      expect(records.every((usage) => usage.request?.purpose === purpose)).toBe(true);
      const totals = new ObservedUsageTotals();
      for (const usage of records) totals.observe(usage);
      expect(totals.tokens).toBe(55);
      expect(records.at(-1)?.request?.collection?.outcome).toBe("success");
    },
  );
  it("closes cancellation as unknown usage and keeps measured zero distinct", async () => {
    const controller = new AbortController();
    const request = collector();
    const records: AgentUsage[] = [];
    for await (const _ of accountRuntimeUsage(
      (async function* () {
        yield usageEvent(request.start());
        yield { type: "text", text: "fixture" } as const;
      })(),
      {
        provider: "fixture",
        model: "fixture",
        signal: controller.signal,
        record: async (usage) => {
          records.push(usage);
        },
      },
    )) {
      controller.abort();
      break;
    }
    expect(records.at(-1)?.request?.collection).toMatchObject({
      outcome: "cancelled",
      availability: "unavailable",
    });
    expect(records.at(-1)?.request?.categories.logicalInput).toBeNull();
  });
  it("drains supplied totals after consumer cancellation without releasing text or tool work", async () => {
    const controller = new AbortController();
    const request = collector();
    const records: AgentUsage[] = [];
    const totals = new ObservedUsageTotals();
    const visible: AgentRuntimeEvent[] = [];
    for await (const event of accountRuntimeUsage(
      (async function* () {
        yield usageEvent(request.start());
        yield { type: "text", text: "first" } as const;
        yield usageEvent(request.snapshot({ input: 140, output: 30 }));
        yield { type: "text", text: "must not escape" } as const;
        yield usageEvent(request.finish("cancelled"));
        throw new Error("aborted transport");
      })(),
      {
        provider: "fixture",
        model: "fixture",
        signal: controller.signal,
        totals,
        record: async (usage) => {
          records.push(usage);
        },
      },
    )) {
      visible.push(event);
      controller.abort();
      break;
    }
    expect(visible).toEqual([{ type: "text", text: "first" }]);
    expect(totals.tokens).toBe(170);
    expect(records.at(-1)?.request?.collection?.outcome).toBe("cancelled");
  });
});
