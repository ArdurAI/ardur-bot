import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { Prisma } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { fleetBotPreference } from "./fleet.js";
import type { RouterDeps } from "./router.js";

function fixture() {
  const bots = ["first", "second"].map((id) => ({
    id,
    computerId: "computer",
    userId: "owner",
    spaceId: "space",
    archivedAt: null,
    placementConsent: false,
    moveAutomatically: false,
    pendingPlacement: { runId: "second-run" } as unknown,
  }));
  const runs = ["first-run", "second-run", "tool-approval", "other-computer"].map((id) => ({
    id,
    userId: "owner",
    status: "waiting_input",
    placement: { status: id === "tool-approval" ? "moved" : "pending" },
    computerId: id === "other-computer" ? "other" : "computer",
  }));
  const matches = (run: (typeof runs)[number], where: Prisma.RunWhereInput) =>
    (!where.id ||
      (typeof where.id === "string"
        ? run.id === where.id
        : Array.isArray(where.id.in) && where.id.in.includes(run.id))) &&
    (!where.userId || where.userId === run.userId) &&
    (!where.status || run.status === where.status) &&
    (!where.bot || run.computerId === "computer") &&
    (!where.placement || run.placement.status === "pending");
  const prisma = {
    $queryRaw: vi.fn(),
    bot: {
      findFirstOrThrow: vi.fn(async ({ where }) => bots.find((bot) => bot.id === where.id)!),
      findMany: vi.fn(async () => bots),
      update: vi.fn(async ({ where, data }) => {
        const bot = bots.find((bot) => bot.id === where.id)!;
        Object.assign(bot, data);
        return bot;
      }),
    },
    run: {
      findMany: vi.fn(async ({ where }) => runs.filter((run) => matches(run, where))),
      updateMany: vi.fn(async ({ where, data }) => {
        const selected = runs.filter((run) => matches(run, where));
        for (const run of selected) Object.assign(run, data);
        return { count: selected.length };
      }),
    },
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(prisma),
  };
  const jobs = { enqueue: vi.fn(async () => undefined) };
  const context: AdapterContext = {
    userId: "owner",
    spaceId: "space",
    operationId: "preference",
    traceId: "preference",
    signal: new AbortController().signal,
  };
  return { bots, runs, prisma, jobs, context, deps: { prisma, jobs } as unknown as RouterDeps };
}

it("keeps shared placement waits paused until every bot consents, then resumes all of them", async () => {
  const f = fixture();
  await fleetBotPreference(f.deps, f.context, { botId: "first", decision: "accept" });
  expect(f.runs.map((run) => run.status)).toEqual(Array(4).fill("waiting_input"));
  expect(f.jobs.enqueue).not.toHaveBeenCalled();
  await fleetBotPreference(f.deps, f.context, { botId: "second", decision: "accept" });
  expect(f.runs.map((run) => run.status)).toEqual([
    "queued",
    "queued",
    "waiting_input",
    "waiting_input",
  ]);
  expect(f.jobs.enqueue).toHaveBeenCalledTimes(2);
  expect(f.prisma.run.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        spaceId: "space",
        status: "waiting_input",
        bot: expect.objectContaining({ computerId: "computer" }),
        placement: { path: ["status"], equals: "pending" },
      }),
    }),
  );
});

it("the last consenting owner releases placement waits for the whole shared computer", async () => {
  const f = fixture();
  f.bots[0]!.userId = "peer-owner";
  f.bots[0]!.placementConsent = true;
  f.runs[0]!.userId = "peer-owner";
  await fleetBotPreference(f.deps, f.context, { botId: "second", decision: "accept" });
  expect(f.runs.map((run) => run.status)).toEqual([
    "queued",
    "queued",
    "waiting_input",
    "waiting_input",
  ]);
  expect(f.prisma.bot.findFirstOrThrow).toHaveBeenCalledWith({
    where: { id: "second", spaceId: "space", userId: "owner" },
  });
});

it("declining a shared move resumes every placement wait without approving the move", async () => {
  const f = fixture();
  await fleetBotPreference(f.deps, f.context, { botId: "first", decision: "decline" });
  expect(f.runs.slice(0, 2).map((run) => [run.status, run.placement.status])).toEqual([
    ["queued", "declined"],
    ["queued", "declined"],
  ]);
  expect(f.bots[0]?.placementConsent).toBe(false);
  expect(f.jobs.enqueue).toHaveBeenCalledTimes(2);
});
