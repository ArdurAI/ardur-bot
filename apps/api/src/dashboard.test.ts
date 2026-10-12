import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { routineOverview, runtimeReliabilityRows, runtimeReliabilitySummary } from "./dashboard.js";

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
it("retains the provider name in the most recent reliability failure", () => {
  const result = runtimeReliabilityRows(
    [
      {
        id: "run",
        status: "failed",
        runtimePin: {
          runtimeKind: "hermes",
          provider: "zai-coding-cn",
          modelId: "glm-5.3",
          effort: "high",
          credentialId: "fixture",
          revision: 1,
        },
        startedAt: now,
        firstReplyAt: null,
        completedAt: now,
        error:
          "Z.AI Coding CN is refusing requests right now (rate or usage limit). Try again later or check your plan.",
      },
    ],
    now,
  );
  expect(result.runtimes.find((row) => row.runtimeKind === "hermes")?.lastFailure).toEqual({
    category: "provider-rate-limit",
    provider: "Z.AI Coding CN",
    at: now.toISOString(),
  });
});
