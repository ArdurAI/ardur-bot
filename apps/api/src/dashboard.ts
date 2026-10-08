import type {
  Actor,
  DashboardNow,
  RoutineOverview,
  RuntimeReliability,
  UsagePeriod,
  UsageSummary,
} from "@ardurbot/contracts";
import { MessageBlock, RuntimeKindSchema, RuntimePinSchema } from "@ardurbot/contracts";
import { isApprovalAskBlock } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { activityRunFailure, listSpaceRuns } from "./runs.js";
import { teamBoard } from "./team.js";

/** One finite request; approval cards are independent of the conversation's message page. */
export async function dashboardNow(prisma: PrismaClient, actor: Actor): Promise<DashboardNow> {
  const [{ rows }, runs] = await Promise.all([
    teamBoard(prisma, actor),
    listSpaceRuns(prisma, actor, "active"),
  ]);
  const waiting = runs.filter((run) => run.status === "waiting_input");
  if (!waiting.length) return { rows, runs, approvals: [] };
  const messages = await prisma.message.findMany({
    where: {
      thread: { spaceId: actor.spaceId, userId: actor.userId },
      role: "bot",
      OR: waiting.map((run) => ({
        runId: run.runId,
        threadId: (run.approvalTarget ?? run).threadId,
      })),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, runId: true, blocks: true },
  });
  const approvals = messages.flatMap((message) => {
    const blocks = MessageBlock.array().safeParse(message.blocks);
    if (!message.runId || !blocks.success) return [];
    return blocks.data.flatMap((block) =>
      block.kind === "ask" && block.status !== "answered" && isApprovalAskBlock(block)
        ? [{ runId: message.runId!, messageId: message.id, block }]
        : [],
    );
  });
  return { rows, runs, approvals };
}

type UsageRow = {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  pricingProvenance: unknown;
  createdAt: Date;
  categoryCoverage: unknown;
  reasoningSemantics: string;
};
const DAY = 86_400_000;

type ReliabilityRun = {
  id: string;
  status: string;
  runtimePin: unknown;
  startedAt: Date | null;
  firstReplyAt: Date | null;
  completedAt: Date | null;
  error: string | null;
};

/** Terminal run rows, not usage-record counts or the capped activity list. */
export function runtimeReliabilityRows(rows: ReliabilityRun[], now: Date): RuntimeReliability {
  const from = new Date(now.getTime() - 7 * DAY);
  const recent = rows.flatMap((run) => {
    const pin = RuntimePinSchema.safeParse(run.runtimePin);
    return pin.success &&
      run.completedAt &&
      run.completedAt >= from &&
      run.completedAt <= now &&
      ["completed", "failed", "cancelled"].includes(run.status)
      ? [{ ...run, completedAt: run.completedAt, kind: pin.data.runtimeKind }]
      : [];
  });
  return {
    from: from.toISOString(),
    asOf: now.toISOString(),
    runtimes: RuntimeKindSchema.options.map((runtimeKind) => {
      const own = recent.filter((run) => run.kind === runtimeKind);
      const completed = own.filter((run) => run.status === "completed").length;
      const failed = own.filter((run) => run.status === "failed").length;
      const samples = own
        .flatMap((run) =>
          run.startedAt &&
          run.firstReplyAt &&
          run.firstReplyAt >= run.startedAt &&
          run.firstReplyAt <= run.completedAt
            ? [run.firstReplyAt.getTime() - run.startedAt.getTime()]
            : [],
        )
        .sort((a, b) => a - b);
      const middle = Math.floor(samples.length / 2);
      const failure = own
        .filter((run) => run.status === "failed")
        .sort(
          (a, b) => b.completedAt.getTime() - a.completedAt.getTime() || b.id.localeCompare(a.id),
        )[0];
      return {
        runtimeKind,
        completed,
        failed,
        cancelled: own.filter((run) => run.status === "cancelled").length,
        successRate: completed + failed ? completed / (completed + failed) : null,
        measuredRuns: samples.length,
        firstReplyMedianMs: samples.length
          ? samples.length % 2
            ? samples[middle]!
            : (samples[middle - 1]! + samples[middle]!) / 2
          : null,
        lastFailure: failure
          ? {
              category: activityRunFailure(failure).failureCategory ?? "other",
              at: failure.completedAt.toISOString(),
            }
          : null,
      };
    }),
  };
}

export async function runtimeReliabilitySummary(
  prisma: PrismaClient,
  actor: Actor,
  now = new Date(),
): Promise<RuntimeReliability> {
  const rows = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      status: { in: ["completed", "failed", "cancelled"] },
      completedAt: { gte: new Date(now.getTime() - 7 * DAY), lte: now },
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
  return runtimeReliabilityRows(rows, now);
}

/**
 * Whether a record's input or output total is only a lower bound. Totals-only records
 * carry no categories and count as reported. Missing cache splits leave totals exact.
 */
function totalsIncomplete(row: UsageRow) {
  const coverage = row.categoryCoverage as Record<string, string> | null;
  return Boolean(
    coverage &&
      (coverage.logicalInput !== "complete" ||
        coverage.output !== "complete" ||
        (row.reasoningSemantics === "separate" && coverage.reasoning !== "complete")),
  );
}

export function usageWindows(now: Date) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const week = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
  return { day, week, from: new Date(day.getTime() - 6 * DAY) };
}

function period(rows: UsageRow[]): UsagePeriod {
  return {
    // Totals-only collectors can combine many model calls in a single ledger record.
    records: rows.length,
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    cost:
      rows.length && rows.every((row) => row.cost !== null && row.pricingProvenance)
        ? rows.reduce((sum, row) => sum + row.cost!, 0)
        : null,
    incomplete: rows.some(totalsIncomplete),
  };
}

export function providerUsage(rows: UsageRow[], now: Date): UsageSummary["providers"] {
  const { day, week, from } = usageWindows(now);
  const recent = rows.filter((row) => row.createdAt >= from && row.createdAt <= now);
  return [...new Set(recent.map((row) => row.provider))].sort().map((provider) => {
    const own = recent.filter((row) => row.provider === provider);
    return {
      provider,
      today: period(own.filter((row) => row.createdAt >= day)),
      week: period(own.filter((row) => row.createdAt >= week)),
      daily: Array.from({ length: 7 }, (_, index) => {
        const date = new Date(from.getTime() + index * DAY).toISOString().slice(0, 10);
        const value = period(own.filter((row) => row.createdAt.toISOString().startsWith(date)));
        return { date, records: value.records, tokens: value.inputTokens + value.outputTokens };
      }),
    };
  });
}

export async function usageSummary(
  prisma: PrismaClient,
  actor: Actor,
  now = new Date(),
): Promise<UsageSummary> {
  const where = { spaceId: actor.spaceId, userId: actor.userId };
  const { day, week, from } = usageWindows(now);
  const [total, recent] = await Promise.all([
    prisma.usageRecord.aggregate({
      where,
      _sum: { inputTokens: true, outputTokens: true },
      _count: { _all: true },
    }),
    prisma.usageRecord.findMany({
      where: { ...where, createdAt: { gte: from, lte: now } },
      select: {
        provider: true,
        inputTokens: true,
        outputTokens: true,
        cost: true,
        pricingProvenance: true,
        createdAt: true,
        categoryCoverage: true,
        reasoningSemantics: true,
      },
    }),
  ]);
  return {
    inputTokens: total._sum.inputTokens ?? 0,
    outputTokens: total._sum.outputTokens ?? 0,
    runs: total._count._all,
    dayStart: day.toISOString(),
    weekStart: week.toISOString(),
    asOf: now.toISOString(),
    providers: providerUsage(recent, now),
  };
}

export async function routineOverview(
  prisma: PrismaClient,
  actor: Actor,
): Promise<RoutineOverview> {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const [next, recent] = await Promise.all([
    prisma.routine.findMany({
      where: { ...scope, active: true, nextRunAt: { not: null }, bot: { archivedAt: null } },
      orderBy: { nextRunAt: "asc" },
      take: 3,
      select: { id: true, name: true, botId: true, nextRunAt: true },
    }),
    prisma.run.findMany({
      where: { ...scope, routineId: { not: null }, completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      take: 3,
      select: {
        id: true,
        botId: true,
        status: true,
        completedAt: true,
        routine: { select: { id: true, name: true } },
      },
    }),
  ]);
  return {
    next: next.map((row) => ({
      id: row.id,
      botId: row.botId,
      name: row.name,
      at: row.nextRunAt!.toISOString(),
    })),
    recent: recent.flatMap((row) =>
      row.routine
        ? [
            {
              id: row.routine.id,
              botId: row.botId,
              name: row.routine.name,
              at: row.completedAt!.toISOString(),
              runId: row.id,
              status: row.status,
            },
          ]
        : [],
    ),
  };
}
