import type { AgentRunRequest, AgentRuntime, AgentUsage } from "@ardurbot/adapter-kit";
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
    rewrittenAt: null as Date | null,
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
  const recordUsage = vi.fn(async (_run: unknown, _usage: AgentUsage) => undefined);
  // Same deterministic offline tokenizer as the tool-loading fixture, not vendor billing.
  const tokens = (text: string) => text.match(/\w+|[^\s\w]/g)?.length ?? 0;
  const runtime: AgentRuntime = {
    describe: () => ({
      id: "brief-fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { scripted: false, streaming: true, compaction: false, tools: false },
    }),
    abort: async () => undefined,
    async *run(request: AgentRunRequest) {
      requests.push(request);
      const text = "## Goal\nCoordinate\n## Open items\nReview task card";
      yield {
        type: "usage",
        provider: "fixture",
        model: "pinned",
        reported: true,
        inputTokens: tokens(`${request.instructions}\n${request.prompt}`),
        outputTokens: tokens(text),
      };
      yield { type: "done", text };
    },
  };
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
    runtime,
    resolve,
    recordUsage,
    deps: {
      prisma,
      claim: (input: Parameters<typeof claimBotRun>[1]) => claimBotRun(prisma, input),
      memoryDocuments: memory,
      resolve,
      recordUsage,
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
it("skips a group turn with no new facts before resolving a model and consumes no tokens", async () => {
  const f = fixture();
  f.state.toolResults = "";
  const rewrittenAt = new Date("2026-09-24T12:00:00Z");
  f.state.rewrittenAt = rewrittenAt;
  f.tx.delegation.findMany.mockResolvedValue([]);
  f.tx.message.findMany.mockResolvedValue([
    { role: "user", blocks: [{ kind: "text", text: "When is launch?" }] },
    { role: "assistant", blocks: [{ kind: "text", text: "Launch on Friday." }] },
    { role: "user", blocks: [{ kind: "text", text: "Thanks!" }] },
  ]);
  const memory = {
    list: vi.fn(async () => ({
      items: [{ path: "briefs/group.md", content: "## Goal\nLaunch on Friday." }],
    })),
  } as unknown as MemoryService;
  await refreshRunBrief({ ...f.deps, memoryDocuments: memory }, "run");
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.requests).toHaveLength(0);
  expect(f.recordUsage).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.state).toMatchObject({
    lastMessageSeq: 1,
    rewrittenAt,
    reason: null,
    leaseExpiresAt: null,
  });
});
it("accounts for exactly one bounded brief call on the changed-fact fixture", async () => {
  const f = fixture();
  await refreshRunBrief(f.deps, "run");
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.model.maxTokens).toBe(2000);
  expect(f.recordUsage).toHaveBeenCalledOnce();
  expect(f.recordUsage.mock.calls[0]?.[1]).toEqual({
    inputTokens: 227,
    model: "pinned",
    outputTokens: 11,
    provider: "fixture",
    request: {
      requestId: "brief:run",
      attemptId: expect.any(String),
      parentRequestId: null,
      purpose: "summary",
      counter: { mode: "delta", epochId: "brief", sequence: 0 },
      inputSemantics: "unknown",
      reasoningSemantics: "unknown",
      categories: {
        logicalInput: 227,
        uncachedInput: null,
        cacheReadInput: null,
        cacheWriteInput: null,
        output: 11,
        reasoning: null,
      },
      cost: null,
      pricingProvenance: null,
    },
  });
  f.run.thread.nextMessageSeq++;
  await refreshRunBrief(f.deps, "run");
  expect(f.recordUsage.mock.calls[1]?.[1].request?.attemptId).not.toBe(
    f.recordUsage.mock.calls[0]?.[1].request?.attemptId,
  );
});
it("preserves identified brief observations on replay and namespaces real maintenance attempts", async () => {
  const f = fixture();
  const request: NonNullable<AgentUsage["request"]> = {
    requestId: "provider-request",
    attemptId: "provider-attempt",
    parentRequestId: null,
    purpose: "main",
    counter: { mode: "cumulative", epochId: "epoch", sequence: 0 },
    inputSemantics: "total-with-cache-subsets",
    reasoningSemantics: "subset-of-output",
    categories: {
      logicalInput: 100,
      uncachedInput: 60,
      cacheReadInput: 30,
      cacheWriteInput: 10,
      output: 50,
      reasoning: 20,
    },
    cost: null,
    pricingProvenance: null,
  };
  const runtime: AgentRuntime = {
    describe: () => ({
      id: "brief-replay-fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { scripted: false, streaming: true, compaction: false, tools: false },
    }),
    abort: async () => undefined,
    async *run() {
      for (let i = 0; i < 2; i++)
        yield {
          type: "usage",
          provider: "fixture",
          model: "pinned",
          inputTokens: 100,
          outputTokens: 50,
          request,
        };
      yield { type: "done", text: "## Goal\nCoordinate\n## Open items\nReview task card" };
    },
  };
  f.resolve.mockResolvedValue({
    runtime,
    model: { provider: "fixture", id: "pinned", thinkingLevel: "high" },
  });
  await refreshRunBrief(f.deps, "run");
  const first = f.recordUsage.mock.calls[0]![1];
  expect(f.recordUsage.mock.calls[1]![1]).toEqual(first);
  expect(first.request).toEqual({ ...request, purpose: "summary", requestId: expect.any(String) });
  expect(first.request!.requestId).not.toBe(request.requestId);
  f.run.thread.nextMessageSeq++;
  await refreshRunBrief(f.deps, "run");
  expect(f.recordUsage.mock.calls[2]![1].request!.requestId).not.toBe(first.request!.requestId);
});
it.each([false, true])(
  "distinguishes unreported brief usage from measured zero (reported=%s)",
  async (reported) => {
    const f = fixture();
    f.resolve.mockResolvedValue({
      model: { provider: "fixture", id: "pinned", thinkingLevel: "high" },
      runtime: {
        ...f.runtime,
        async *run() {
          yield {
            type: "usage",
            provider: "fixture",
            model: "pinned",
            inputTokens: 0,
            outputTokens: 0,
            reported,
          };
          yield { type: "done", text: "## Goal\nCoordinate" };
        },
      },
    });
    await refreshRunBrief(f.deps, "run");
    expect(f.recordUsage).toHaveBeenCalledOnce();
    expect(f.recordUsage.mock.calls[0]![1]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      request: {
        purpose: "summary",
        categories: {
          logicalInput: reported ? 0 : null,
          output: reported ? 0 : null,
          cacheReadInput: null,
        },
        cost: null,
      },
    });
  },
);
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
