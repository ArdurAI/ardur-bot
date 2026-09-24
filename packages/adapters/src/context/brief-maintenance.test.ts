import type { AgentRunRequest, AgentRuntime } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import type { MemoryService } from "@ardurbot/memory";
import { maintainBriefs, markBriefPending, refreshRunBrief } from "@ardurbot/memory";
import { expect, it, vi } from "vitest";
import { claimBotRun } from "./concurrency.js";

function fixture() {
  const state = {
    id: "brief",
    pendingRunId: "run",
    attemptedAt: null,
    historyGeneration: 0,
    lastMessageSeq: -1,
    toolResults: "read_document: saved result",
  };
  const run = {
    id: "run",
    botId: "chief",
    threadId: "thread",
    taskId: "task",
    spaceId: "space",
    userId: "owner",
    status: "completed",
    runtimePin: { modelId: "pinned" },
    thread: { id: "thread", groupId: "group", nextMessageSeq: 2, historyCompactionGeneration: 0 },
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => run),
      findMany: vi.fn(async () => [run]),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "chief",
        concurrentRuns: 3,
        space: { concurrentRuns: 3 },
      })),
    },
    botBrief: {
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => state),
      upsert: vi.fn(),
      updateMany: vi.fn(async ({ data }: { data: object }) => {
        Object.assign(state, data);
        return { count: 1 };
      }),
    },
    message: {
      findMany: vi.fn(async () => [
        { role: "assistant", blocks: [{ kind: "text", text: "Work reported" }] },
      ]),
    },
    delegationRoot: { findUnique: vi.fn(async () => null) },
    delegation: {
      findMany: vi.fn(async () => [
        { id: "task-card", status: "completed", acceptedAt: null, card: { goal: "Review" } },
      ]),
    },
  };
  const commit = vi.fn(async (input) => ({ ...input, id: "document", revision: 1 }));
  const memory = { list: vi.fn(async () => ({ items: [] })), commit } as unknown as MemoryService;
  const requests: AgentRunRequest[] = [];
  const runtime = {
    describe: () => ({ capabilities: { scripted: false } }),
    async *run(request: AgentRunRequest) {
      requests.push(request);
      yield { type: "done", text: "## Goal\nCoordinate\n## Open items\nReview task card" };
    },
  } as unknown as AgentRuntime;
  const resolve = vi.fn(async () => ({
    runtime,
    model: { provider: "fixture", id: "pinned", thinkingLevel: "high" as const },
  }));
  const prisma = {
    ...tx,
    $transaction: (action: (client: typeof tx) => Promise<unknown>) => action(tx),
  } as unknown as PrismaClient;
  return {
    state,
    run,
    tx,
    commit,
    requests,
    resolve,
    deps: {
      prisma,
      claim: (input: Parameters<typeof claimBotRun>[1]) => claimBotRun(prisma, input),
      memoryDocuments: memory,
      resolve,
      secrets: [],
    },
  };
}
it("marks a changed group pending and rewrites after the turn with the selected model and no tools", async () => {
  const f = fixture();
  await markBriefPending(f.deps.prisma, "run");
  expect(f.tx.botBrief.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({ groupKey: "group", pendingRunId: "run" }),
    }),
  );
  await refreshRunBrief(f.deps, "run");
  expect(f.requests[0]).toMatchObject({
    tools: "none",
    model: { id: "pinned", thinkingLevel: "high", maxTokens: 2000 },
  });
  expect(f.requests[0]?.prompt).toContain('"acceptedAt":null');
  expect(f.commit).toHaveBeenCalledOnce();
  expect(f.state.lastMessageSeq).toBe(1);
  const attempts = f.requests.length;
  await refreshRunBrief(f.deps, "run");
  expect(f.requests).toHaveLength(attempts);
  // Another bot can advance the shared thread while this bot's pinned source run stays the same.
  f.run.thread.nextMessageSeq++;
  await refreshRunBrief(f.deps, "run");
  expect(f.requests).toHaveLength(attempts + 1);
  expect(f.state.lastMessageSeq).toBe(2);
});
it("leaves unavailable runs pending with a reason and never rewrites an active turn", async () => {
  const f = fixture();
  await refreshRunBrief({ ...f.deps, resolve: async () => null }, "run");
  expect(f.state).toMatchObject({ pendingRunId: "run", reason: "Model unavailable" });
  expect(f.commit).not.toHaveBeenCalled();
  f.run.status = "running";
  await refreshRunBrief(f.deps, "run");
  expect(f.requests).toHaveLength(0);
});
it("bounds idle maintenance to five changed briefs", async () => {
  const query = vi.fn(async (sql: TemplateStringsArray) => {
    expect(sql.join("")).toContain("LIMIT 5");
    expect(sql.join("")).toContain('b."lastMessageSeq" < t."nextMessageSeq" - 1');
    return Array.from({ length: 5 }, (_, index) => ({ pendingRunId: `run-${index}` }));
  });
  const refresh = vi.fn(async () => undefined);
  expect(await maintainBriefs({ $queryRaw: query } as unknown as PrismaClient, refresh)).toBe(5);
  expect(refresh).toHaveBeenCalledTimes(5);
});
it("does not use the model when the source task budget is exhausted", async () => {
  const f = fixture();
  const prisma = {
    ...f.deps.prisma,
    delegationRoot: {
      findUnique: async () => ({
        cancelRequestedAt: null,
        deadlineAt: new Date(Date.now() + 60000),
        usedTokens: 120000,
        tokenLimit: 120000,
      }),
    },
  } as unknown as PrismaClient;
  await refreshRunBrief({ ...f.deps, prisma }, "run");
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.state).toMatchObject({
    reason: "Task budget reached",
    lastMessageSeq: -1,
    leaseExpiresAt: null,
  });
});
