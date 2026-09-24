import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { ComparisonStart } from "@ardurbot/contracts";
import type { Bot, PrismaClient } from "@ardurbot/db";
import { finishDelegation } from "@ardurbot/db";
import { fixture, snapshot } from "@ardurbot/db/testing/delegation";
import { vi } from "vitest";
import type { ResolvedRunPin } from "./run-model-pin.js";

export const comparisonScope = { spaceId: "space", userId: "owner" };
export const comparisonInput: ComparisonStart = {
  coordinatorBotId: "coordinator",
  participantBotIds: ["coordinator", "worker"],
  text: "Review the evidence",
  artifactIds: [],
  reserveMerge: true,
  clientNonce: "comparison-request",
};

/** Reuses P1's serializable transaction fixture and real admission/accounting functions. */
export function comparisonFixture(rootPolicy = {}) {
  const f = fixture();
  const scoped = (where: { spaceId?: string; userId?: string }) => {
    if ((where.spaceId && where.spaceId !== "space") || (where.userId && where.userId !== "owner"))
      throw new Error("not found");
  };
  f.tx.bot.findFirstOrThrow.mockImplementation(async ({ where }) => {
    scoped(where);
    if (!["coordinator", "worker", "third", "fourth"].includes(where.id))
      throw new Error("not found");
    return {
      ...f.bot,
      ...comparisonScope,
      id: where.id,
      name: where.id,
      instructions: "Frozen environment note",
      title: "",
      description: "",
      thread: { id: `thread-${where.id}` },
    };
  });
  f.tx.run.create.mockImplementation(async ({ data }) => {
    const row = {
      id: `run-${f.state().runs.length}`,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      remoteDeviceGrantIds: [],
      ...data,
    };
    f.state().runs.push(row);
    return row;
  });
  f.tx.task.create.mockImplementation(async ({ data }) => ({
    id: `task-${f.state().runs.length}`,
    ...data,
  }));
  Object.assign(f.tx.spaceMember, { findUnique: vi.fn(async () => ({ role: "member" })) });
  Object.assign(f.tx.thread, {
    findUniqueOrThrow: vi.fn(async ({ where }) => ({ id: `thread-${where.botId}` })),
  });
  Object.assign(f.tx.delegationRoot, {
    create: vi.fn(async ({ data }) =>
      f.tx.delegationRoot.upsert({ create: { ...data, ...rootPolicy } }),
    ),
    findUnique: vi.fn(async () => f.state().root),
  });
  Object.assign(f.tx.run, {
    findMany: vi.fn(async ({ where }) => {
      scoped(where);
      return f.state().runs.filter((run) => where.id.in.includes(run.id));
    }),
  });
  Object.assign(f.tx.usageRecord, {
    findMany: vi.fn(async ({ where }) => {
      scoped(where);
      return f.state().usage.filter((row) => where.runId.in.includes(row.runId));
    }),
  });
  Object.assign(f.tx.artifact, { findMany: vi.fn(async () => []) });
  Object.assign(f.tx.message, {
    findMany: vi.fn(async ({ where }) => {
      scoped(where.thread);
      return f
        .state()
        .messages.filter((row) =>
          typeof where.runId === "string"
            ? row.runId === where.runId
            : where.runId.in.includes(row.runId),
        );
    }),
  });
  const comparison = {
    findUnique: vi.fn(async ({ where }) => {
      const key = where.spaceId_userId_clientNonce;
      return (
        f
          .state()
          .comparisons.find((row) =>
            key
              ? row.spaceId === key.spaceId &&
                row.userId === key.userId &&
                row.clientNonce === key.clientNonce
              : row.id === where.id,
          ) ?? null
      );
    }),
    findFirstOrThrow: vi.fn(async ({ where }) => {
      scoped(where);
      const row = f
        .state()
        .comparisons.find(
          (row) =>
            row.id === where.id &&
            (!where.parentRunId || row.parentRunId === where.parentRunId) &&
            (!where.rootTaskId || row.rootTaskId === where.rootTaskId),
        );
      if (!row) throw new Error("not found");
      return {
        ...row,
        executions: f
          .state()
          .executions.filter((execution) => execution.comparisonId === row.id)
          .sort((a, b) => a.position - b.position),
      };
    }),
    findMany: vi.fn(async ({ where }) => {
      scoped(where);
      return f.state().comparisons;
    }),
    create: vi.fn(async ({ data }) => {
      const row = {
        id: `comparison-${f.state().comparisons.length}`,
        createdAt: new Date(),
        ...structuredClone(data),
      };
      f.state().comparisons.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }) => {
      const row = f.state().comparisons.find((row) => row.id === where.id);
      const tokens = data.budgetTokens?.increment;
      Object.assign(row, data);
      if (tokens) row.budgetTokens = 20000 + tokens;
      return row;
    }),
  };
  const comparisonExecution = {
    create: vi.fn(async ({ data }) => {
      const row = { id: `execution-${f.state().executions.length}`, ...structuredClone(data) };
      f.state().executions.push(row);
      return row;
    }),
    findFirstOrThrow: vi.fn(async ({ where }) => {
      scoped(where.comparison);
      const row = f
        .state()
        .executions.find(
          (row) =>
            row.runId === where.runId &&
            row.comparisonId === where.comparisonId &&
            row.botId === where.botId,
        );
      if (!row) throw new Error("not found");
      return row;
    }),
  };
  Object.assign(f.tx, { comparison, comparisonExecution });
  const prisma = f.worker() as PrismaClient;
  const resolvePin = vi.fn(
    async (bot: Bot): Promise<ResolvedRunPin> => ({
      kind: "resolved",
      pin: { ...snapshot.pin, modelId: bot.id },
      provider: snapshot.pin.provider!,
      id: bot.id,
      thinkingLevel: "high",
      baseUrl: "http://localhost:1234",
    }),
  );
  const enqueue = vi.fn(async () => {});
  const deps = { prisma, resolvePin, jobs: { enqueue } as unknown as JobPublisher };
  const complete = async (runId: string, output: string) => {
    const run = f.state().runs.find((run) => run.id === runId);
    run.status = "completed";
    run.startedAt = new Date();
    run.completedAt = new Date();
    f.state().messages.push({
      id: `output-${runId}`,
      runId,
      role: "bot",
      blocks: [{ kind: "text", text: output }],
      seq: 1,
    });
    await prisma.$transaction((tx) =>
      finishDelegation(tx, run.delegationId, "completed", output, runId),
    );
  };
  return { ...f, deps, prisma, comparison, comparisonExecution, enqueue, complete, resolvePin };
}
