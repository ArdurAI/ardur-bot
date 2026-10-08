import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { piWireUsage } from "../../../packages/adapters/src/pi-request-usage.js";
import { accumulateRequestUsage } from "../../../packages/adapters/src/request-usage.js";
import {
  providerUsage,
  routineOverview,
  runtimeReliabilityRows,
  runtimeReliabilitySummary,
  usageSummary,
  usageWindows,
} from "./dashboard.js";

const now = new Date("2026-09-24T12:00:00Z");
describe("durable runtime reliability", () => {
  const pin = {
    runtimeKind: "pi",
    provider: "fixture",
    modelId: "fixture",
    effort: null,
    credentialId: null,
    revision: 1,
  };
  const run = (status = "completed", measured = true, kind = "pi") => ({
    id: "run",
    status,
    runtimePin: { ...pin, runtimeKind: kind },
    error: null as string | null,
    startedAt: new Date("2026-09-24T11:00:00Z"),
    firstReplyAt: measured ? new Date("2026-09-24T11:00:02Z") : null,
    completedAt: now,
  });
  it("keeps cancellations out of success and textless runs out of latency", () => {
    const result = runtimeReliabilityRows(
      [
        run(),
        run("completed", false),
        run("failed"),
        run("cancelled", false),
        { ...run(), firstReplyAt: new Date("2026-09-24T11:00:04Z") },
      ],
      now,
    ).runtimes[0]!;
    expect(result).toMatchObject({
      completed: 3,
      failed: 1,
      cancelled: 1,
      successRate: 0.75,
      measuredRuns: 3,
      firstReplyMedianMs: 2000,
      lastFailure: { category: "other", at: now.toISOString() },
    });
    expect(runtimeReliabilityRows([run("cancelled", false)], now).runtimes[0]).toMatchObject({
      successRate: null,
      measuredRuns: 0,
      firstReplyMedianMs: null,
    });
  });
  it("uses an even median and rejects invalid timestamps without assigning zero", () => {
    const rows = [
      run(),
      { ...run(), firstReplyAt: new Date("2026-09-24T11:00:04Z") },
      { ...run(), firstReplyAt: new Date("2026-09-24T10:59:59Z") },
      { ...run(), firstReplyAt: new Date("2026-09-24T12:00:01Z") },
      { ...run(), startedAt: null },
    ];
    expect(runtimeReliabilityRows(rows, now).runtimes[0]).toMatchObject({
      completed: 5,
      measuredRuns: 2,
      firstReplyMedianMs: 3000,
    });
  });
  it("fixes the completed-at window and groups by saved pins, never current bot settings", () => {
    const from = new Date("2026-09-17T12:00:00Z");
    const result = runtimeReliabilityRows(
      [
        { ...run("completed", false), completedAt: from },
        { ...run(), completedAt: new Date("2026-09-17T11:59:59.999Z") },
        { ...run(), completedAt: new Date("2026-09-24T12:00:00.001Z") },
        run("running"),
        run("queued"),
        run("completed", true, "codex-app-server"),
        { ...run(), runtimePin: null },
        { ...run(), runtimePin: { ...pin, runtimeKind: "unregistered" } },
      ],
      now,
    );
    expect(result.from).toBe(from.toISOString());
    expect(result.runtimes[0]).toMatchObject({ completed: 1, measuredRuns: 0 });
    expect(result.runtimes.find((row) => row.runtimeKind === "codex-app-server")).toMatchObject({
      completed: 1,
      measuredRuns: 1,
    });
    expect(result.runtimes.find((row) => row.runtimeKind === "hermes")).toMatchObject({
      completed: 0,
      failed: 0,
      cancelled: 0,
      successRate: null,
      firstReplyMedianMs: null,
    });
  });
  it("returns only a translated cause category from the latest failure, not raw errors", () => {
    const rows = [
      { ...run("failed"), error: "Ardur's usage limit is reached. Try again after it resets." },
      {
        ...run("failed"),
        completedAt: new Date("2026-09-24T11:59:00Z"),
        error: "private fixture content",
      },
    ];
    const result = runtimeReliabilityRows(rows, now);
    expect(result.runtimes[0]?.lastFailure?.category).toBe("usage-limit");
    expect(JSON.stringify(result)).not.toContain("private fixture content");
    expect(JSON.stringify(result)).not.toContain("error");
  });
  it("uses the actor's user, space and visible-run scope with no recent-list cap", async () => {
    const findMany = vi.fn(async () => []);
    await runtimeReliabilitySummary(
      { run: { findMany } } as unknown as PrismaClient,
      { userId: "owner", spaceId: "space" } as Actor,
      now,
    );
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        userId: "owner",
        spaceId: "space",
        bot: { archivedAt: null },
        status: { in: ["completed", "failed", "cancelled"] },
        completedAt: { gte: new Date("2026-09-17T12:00:00Z"), lte: now },
      },
      select: {
        id: true,
        status: true,
        runtimePin: true,
        startedAt: true,
        firstReplyAt: true,
        completedAt: true,
        error: true,
      },
    });
  });
});
type Reported = { categoryCoverage: Record<string, string> | null; reasoningSemantics: string };
/** Totals-only records carry no categories. */
const totalsOnly: Reported = { categoryCoverage: null, reasoningSemantics: "unknown" };
const row = (
  provider: string,
  createdAt: string,
  cost: number | null = null,
  pricingProvenance: unknown = null,
  reported: Reported = totalsOnly,
) => ({
  provider,
  createdAt: new Date(createdAt),
  cost,
  pricingProvenance,
  inputTokens: 20,
  outputTokens: 5,
  ...reported,
});
const categories = (overrides: Record<string, string> = {}) => ({
  logicalInput: "complete",
  uncachedInput: "complete",
  cacheReadInput: "complete",
  cacheWriteInput: "complete",
  output: "complete",
  reasoning: "complete",
  ...overrides,
});
// Stored coverage for fully reported calls whose providers omit some cache or reasoning splits.
const openAiResponse: Reported = {
  categoryCoverage: categories({ uncachedInput: "unknown", cacheWriteInput: "unknown" }),
  reasoningSemantics: "subset-of-output",
};
const anthropicWithoutThinking: Reported = {
  categoryCoverage: categories({ reasoning: "unknown" }),
  reasoningSemantics: "unknown",
};
// Stored coverage whose input or output total is only a lower bound.
const notReported: Reported = {
  categoryCoverage: Object.fromEntries(
    Object.keys(categories()).map((key) => [key, "unknown"]),
  ) as Record<string, string>,
  reasoningSemantics: "unknown",
};
const interrupted: Reported = {
  categoryCoverage: categories({ logicalInput: "partial", output: "partial" }),
  reasoningSemantics: "subset-of-output",
};
const separateReasoningMissing: Reported = {
  categoryCoverage: categories({ reasoning: "unknown" }),
  reasoningSemantics: "separate",
};
describe("dashboard usage", () => {
  it("uses UTC day and Monday boundaries, independent of the server timezone", () => {
    expect(usageWindows(now)).toEqual({
      day: new Date("2026-09-24T00:00:00Z"),
      week: new Date("2026-09-21T00:00:00Z"),
      from: new Date("2026-09-18T00:00:00Z"),
    });
    expect(usageWindows(new Date("2026-09-27T23:59:59Z")).week.toISOString()).toBe(
      "2026-09-21T00:00:00.000Z",
    );
  });
  it("groups usage records and tokens, omits incomplete costs, and fills real zero days", () => {
    const result = providerUsage(
      [
        row("local", "2026-09-24T00:00:00Z"),
        row("paid", "2026-09-24T11:00:00Z", 0.2, { source: "reported" }),
        row("paid", "2026-09-23T11:00:00Z", 99),
        row("paid", "2026-09-20T11:00:00Z", 0.1, { source: "reported" }),
        row("old", "2026-09-17T23:59:59Z"),
        row("future", "2026-09-25T00:00:00Z"),
      ],
      now,
    );
    expect(result.map((provider) => provider.provider)).toEqual(["local", "paid"]);
    expect(result[0]!.today).toEqual({
      records: 1,
      inputTokens: 20,
      outputTokens: 5,
      cost: null,
      incomplete: false,
    });
    expect(result[1]!.today.cost).toBe(0.2);
    expect(result[1]!.week).toEqual({
      records: 2,
      inputTokens: 40,
      outputTokens: 10,
      cost: null,
      incomplete: false,
    });
    expect(result[1]!.daily.map((day) => day.tokens)).toEqual([0, 0, 25, 0, 0, 25, 25]);
  });
  it("keeps a period complete when every input and output total was reported", () => {
    const [usage] = providerUsage(
      [
        row("fixture", "2026-09-24T09:00:00Z", null, null, openAiResponse),
        row("fixture", "2026-09-24T10:00:00Z", null, null, anthropicWithoutThinking),
        row("fixture", "2026-09-24T11:00:00Z"),
      ],
      now,
    );
    expect(usage!.today).toMatchObject({ records: 3, inputTokens: 60, incomplete: false });
    expect(usage!.week.incomplete).toBe(false);
  });
  it("marks a period partially reported only when a record's total is a lower bound", () => {
    for (const reported of [notReported, interrupted, separateReasoningMissing]) {
      const [usage] = providerUsage(
        [
          row("fixture", "2026-09-24T09:00:00Z", null, null, openAiResponse),
          row("fixture", "2026-09-24T10:00:00Z", null, null, reported),
        ],
        now,
      );
      expect(usage!.today).toMatchObject({ records: 2, inputTokens: 40, incomplete: true });
    }
    const [usage] = providerUsage(
      [
        row("fixture", "2026-09-22T10:00:00Z", null, null, notReported),
        row("fixture", "2026-09-24T10:00:00Z", null, null, openAiResponse),
      ],
      now,
    );
    expect(usage!.today.incomplete).toBe(false);
    expect(usage!.week.incomplete).toBe(true);
  });
  it("marks Partially reported when an Anthropic stream fails after message_start", () => {
    const counts = piWireUsage("anthropic-messages", {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 25,
          output_tokens: 1,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 15,
        },
      },
    });
    const collector = new RequestUsageCollector({
      provider: "anthropic",
      model: "claude-fixture",
      mappingVersion: "pi-anthropic-messages-wire-v1",
      inputSemantics: "additive-cache-categories",
    });
    collector.start();
    collector.snapshot(counts!);
    const finished = collector.finish("cancelled");
    const totals = accumulateRequestUsage(null, finished.request!);
    const [usage] = providerUsage(
      [
        {
          provider: "anthropic",
          createdAt: now,
          cost: null,
          pricingProvenance: null,
          inputTokens: finished.inputTokens,
          outputTokens: finished.outputTokens,
          categoryCoverage: totals.categoryCoverage,
          reasoningSemantics: finished.request!.reasoningSemantics,
        },
      ],
      now,
    );
    expect(totals.categoryCoverage.output).toBe("partial");
    expect(usage!.today).toMatchObject({
      records: 1,
      inputTokens: 120,
      outputTokens: 1,
      incomplete: true,
    });
    expect(usage!.week.incomplete).toBe(true);
  });
  it("retains the existing lifetime summary fields and bounds the provider query to the actor", async () => {
    const findMany = vi.fn(async () => []);
    const aggregate = vi.fn(async () => ({
      _sum: { inputTokens: 70, outputTokens: null },
      _count: { _all: 9 },
    }));
    const prisma = { usageRecord: { findMany, aggregate } } as unknown as PrismaClient;
    const result = await usageSummary(prisma, { userId: "viewer", spaceId: "space" } as Actor, now);
    expect(result).toMatchObject({ inputTokens: 70, outputTokens: 0, runs: 9, providers: [] });
    // Lifetime totals are one aggregate; nothing scans the whole history for coverage.
    expect(aggregate).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty("incomplete");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "viewer",
          spaceId: "space",
          createdAt: { gte: new Date("2026-09-18T00:00:00Z"), lte: now },
        },
        select: expect.objectContaining({ categoryCoverage: true, reasoningSemantics: true }),
      }),
    );
  });
});
it("selects the next three routines and last three actual results within the actor's space", async () => {
  const routine = { id: "routine", name: "Check", botId: "bot", nextRunAt: now };
  const next = vi.fn(async () => [routine]);
  const recent = vi.fn(async () => [
    { id: "run", botId: "bot", status: "failed", completedAt: now, routine },
  ]);
  const prisma = {
    routine: { findMany: next },
    run: { findMany: recent },
  } as unknown as PrismaClient;
  const output = await routineOverview(prisma, { userId: "viewer", spaceId: "space" } as Actor);
  expect(output.next[0]).toEqual({
    id: "routine",
    name: "Check",
    botId: "bot",
    at: now.toISOString(),
  });
  expect(output.recent[0]).toMatchObject({ runId: "run", status: "failed" });
  expect(next).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 3,
      orderBy: { nextRunAt: "asc" },
      where: expect.objectContaining({ userId: "viewer", spaceId: "space", active: true }),
    }),
  );
  expect(recent).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 3,
      orderBy: { completedAt: "desc" },
      where: expect.objectContaining({
        userId: "viewer",
        spaceId: "space",
        routineId: { not: null },
        completedAt: { not: null },
      }),
    }),
  );
});

it("reports totals-only aggregates as usage records without inventing request identity", () => {
  const legacy = {
    ...row("claude-code", now.toISOString()),
    requestId: null,
    attemptId: null,
    categoryCoverage: null,
    purpose: "legacy",
  };
  const [provider] = providerUsage([legacy], now);
  expect(provider?.today).toMatchObject({ records: 1, inputTokens: 20, outputTokens: 5 });
  expect(provider?.today).not.toHaveProperty("requests");
  expect(provider?.daily.at(-1)).toEqual({ date: "2026-09-24", records: 1, tokens: 25 });
});
