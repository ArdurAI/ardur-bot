import type {
  Actor,
  Comparison,
  ComparisonParticipant,
  ComparisonResult,
} from "@ardurbot/contracts";
import {
  ComparisonParticipantSchema,
  ComparisonSchema,
  ComparisonSnapshotSchema,
  DELEGATION_LIMITS,
  MessageBlock,
  RuntimeInfoSchema,
} from "@ardurbot/contracts";
import { redactTaskValue } from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";

type Scope = Pick<Actor, "spaceId" | "userId">;

/** Results are projected from ordinary runs, messages and usage; participant order is immutable. */
export async function readComparison(
  prisma: PrismaClient | Prisma.TransactionClient,
  scope: Scope,
  id: string,
): Promise<Comparison> {
  const row = await prisma.comparison.findFirstOrThrow({
    where: { id, ...scope },
    include: { executions: { orderBy: { position: "asc" } } },
  });
  const runIds = row.executions.map((execution) => execution.runId);
  const [runs, messages, usage, artifacts, root] = await Promise.all([
    prisma.run.findMany({ where: { ...scope, id: { in: runIds } } }),
    prisma.message.findMany({
      where: { runId: { in: runIds }, thread: scope, role: "bot" },
      orderBy: { seq: "asc" },
    }),
    prisma.usageRecord.findMany({
      where: { ...scope, runId: { in: runIds } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.artifact.findMany({ where: { ...scope, runId: { in: runIds } } }),
    prisma.delegationRoot.findFirstOrThrow({ where: { ...scope, rootTaskId: row.rootTaskId } }),
  ]);
  const result = (execution: (typeof row.executions)[number]): ComparisonResult => {
    const run = runs.find((run) => run.id === execution.runId);
    const ownMessages = messages.filter((message) => message.runId === execution.runId);
    const parsed = ownMessages.map((message) => ({
      ...message,
      blocks: MessageBlock.array().parse(message.blocks),
    }));
    const approvals = parsed.flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.kind === "ask" && block.status === "pending"
          ? [{ messageId: message.id, block }]
          : [],
      ),
    );
    const outputs = parsed.filter((message) =>
      message.blocks.some((block) => block.kind === "text"),
    );
    const output = outputs
      .flatMap((message) =>
        message.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])),
      )
      .join("\n\n");
    const spent = usage.filter((item) => item.runId === execution.runId);
    const info = RuntimeInfoSchema.safeParse(run?.runtimeInfo);
    const status: ComparisonResult["status"] = !run
      ? "incomplete"
      : run.status === "waiting_input"
        ? "waiting-approval"
        : run.status === "completed"
          ? output
            ? "completed"
            : "incomplete"
          : run.status === "failed"
            ? "failed"
            : run.status === "cancelled"
              ? "cancelled"
              : run.status === "running"
                ? "running"
                : run.status === "queued" || run.status === "leased"
                  ? "queued"
                  : "incomplete";
    return {
      botId: execution.botId,
      runId: execution.runId,
      delegationId: execution.delegationId,
      status,
      output,
      outputMessageIds: outputs.map((message) => message.id),
      outputArtifactIds: artifacts
        .filter((item) => item.runId === execution.runId)
        .map((item) => item.id),
      citations: [...new Set(output.match(/https?:\/\/[^\s<>"\])]+/gu) ?? [])],
      usage: {
        inputTokens: spent.reduce((n, item) => n + item.inputTokens, 0),
        outputTokens: spent.reduce((n, item) => n + item.outputTokens, 0),
        reported: spent.length > 0,
        costs: spent.flatMap((item) =>
          item.cost !== null && item.pricingProvenance
            ? [
                {
                  amount: item.cost,
                  provenance: redactTaskValue(JSON.stringify(item.pricingProvenance)),
                },
              ]
            : [],
        ),
      },
      durationMs: run?.startedAt
        ? Math.max(0, (run.completedAt ?? new Date()).getTime() - run.startedAt.getTime())
        : null,
      startedAt: run?.startedAt?.toISOString() ?? null,
      completedAt: run?.completedAt?.toISOString() ?? null,
      failure: run?.error ? redactTaskValue(run.error) : null,
      provenance: {
        reportedModel: info.success ? (info.data.reportedModel ?? null) : null,
        reportedModelVersion: info.success ? (info.data.reportedModelVersion ?? null) : null,
        memoryRead: false,
        memoryDiffered: false,
        ambientHistory: false,
        toolsRestricted: true,
      },
      approvals,
    };
  };
  const participants = ComparisonParticipantSchema.array().parse(row.participants);
  const results = row.executions
    .filter((execution) => execution.position < participants.length)
    .map(result);
  const merged = row.executions.find((execution) => execution.position === 4);
  const done =
    results.length === participants.length &&
    results.every((item) =>
      ["completed", "failed", "cancelled", "incomplete"].includes(item.status),
    );
  return ComparisonSchema.parse({
    id: row.id,
    spaceId: row.spaceId,
    requesterUserId: row.userId,
    coordinatorBotId: row.coordinatorBotId,
    rootTaskId: row.rootTaskId,
    snapshot: ComparisonSnapshotSchema.parse(row.snapshot),
    participants,
    results,
    budget: {
      tokens: row.budgetTokens,
      perRunTokens: DELEGATION_LIMITS.reservationTokens,
      mergeReserved: row.mergeReserved,
      deadlineAt: root.deadlineAt.toISOString(),
    },
    status: done
      ? results.every((item) => item.status === "completed")
        ? "completed"
        : "incomplete"
      : "running",
    merge: merged
      ? {
          participant: ComparisonParticipantSchema.parse(merged.participant),
          selectedRunIds: merged.selectedRunIds,
          result: result(merged),
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  });
}

export async function listComparisons(prisma: PrismaClient, scope: Scope) {
  const rows = await prisma.comparison.findMany({
    where: scope,
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true },
  });
  return Promise.all(rows.map((row) => readComparison(prisma, scope, row.id)));
}

export function comparisonMergeInput(
  selected: ComparisonResult[],
  participants: ComparisonParticipant[],
) {
  return {
    instruction:
      "Merge only these selected outputs. Preserve sources, uncertainty and disagreements explicitly; do not rank the sources or invent agreement.",
    sources: selected.map((result) => ({
      runId: result.runId,
      botId: result.botId,
      pin: participants.find((item) => item.botId === result.botId)!.executing,
      outputMessageIds: result.outputMessageIds,
      outputArtifactIds: result.outputArtifactIds,
      output: result.output,
      citations: result.citations,
      provenance: result.provenance,
    })),
  };
}
