import type { AgentRunRequest, AgentUsage } from "@ardurbot/adapter-kit";
import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import type { DocumentRevision } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import { consolidateLearning, overlappingLearnedSkills } from "./learning-consolidation.js";
import { saveCuratorProposal } from "./learning-curator.js";

vi.mock("./learning-curator.js", () => ({ saveCuratorProposal: vi.fn(async () => true) }));
const now = new Date("2026-09-23T00:00:00Z");
const pin = {
  provider: "openai-compatible",
  modelId: "local",
  effort: "medium",
  credentialId: "connection",
  revision: 1,
};
const revisions = [1, 2].map((i) => ({
  documentId: `doc${i}`,
  revision: i,
  scopeKey: { kind: "bot", spaceId: "space", userId: "user", botId: "bot" },
  content: `---\nname: reports-${i}\ndescription: Weekly report summary preparation\n---\nPrepare the summary.`,
})) as DocumentRevision[];
function fixture(output: "valid" | "tool" = "valid", usage?: AgentUsage[]) {
  const config = {
    enabled: true,
    consolidationEnabled: true,
    configuredBy: "user",
    reviewerPin: pin,
    botDailyTokens: 30000,
    spaceDailyTokens: 150000,
    maxOutputTokens: 2000,
    maxOutputChars: 12000,
    timeoutMs: 1000,
    updatedAt: now,
  };
  const execute = vi.fn(async function* (_request: AgentRunRequest) {
    if (output === "tool") {
      yield { type: "tool", name: "write_file" };
      return;
    }
    for (const event of usage ?? [{ inputTokens: 20, outputTokens: 30 }])
      yield { type: "usage", ...event };
    yield {
      type: "text",
      text: JSON.stringify({
        content:
          "---\nname: report-preparation\ndescription: Weekly report summary preparation\n---\nPrepare the summary.",
      }),
    };
  });
  const reviewExecution = {
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
  };
  const tx = { $queryRaw: vi.fn(), reviewExecution };
  const deps = {
    prisma: {
      $transaction: (f: (tx: unknown) => unknown) => f(tx),
      reviewExecution,
      run: {
        findFirst: async () => ({
          id: "run",
          threadId: "thread",
          thread: { historyCompactionGeneration: 0 },
        }),
      },
      spaceLearningConfig: { findUnique: async () => config },
      secret: { findMany: async () => [] },
      botSecret: { findMany: async () => [] },
      agentSkill: { findFirst: async () => ({ id: "skill" }) },
    },
    memoryDocuments: { read: async (id: string) => revisions.find((r) => r.documentId === id) },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: execute },
    secretStore: {},
    resolvePin: async () => ({ kind: "resolved", ...pin, id: "local" }),
  };
  return { deps, config, execute, reviewExecution };
}
it("settles cumulative snapshots and their terminal receipt once", async () => {
  const request = new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
  const started = request.start();
  const snapshot = request.snapshot({ input: 100, output: 30 });
  const f = fixture("valid", [started, snapshot, request.finish("success"), snapshot]);
  const result = await consolidateLearning(
    f.deps as never,
    { spaceId: "space", userId: "user" },
    revisions,
    f.config as never,
    now,
  );
  expect(result.tokens).toBe(130);
  expect(f.reviewExecution.update).toHaveBeenLastCalledWith({
    where: expect.anything(),
    data: expect.objectContaining({ tokens: 130, reservedTokens: 130 }),
  });
});

it("keeps unmeasured cumulative receipts distinct from measured zero", async () => {
  const request = new RequestUsageCollector({
    provider: "fixture",
    model: "fixture",
    inputSemantics: "total-with-cache-subsets",
    mappingVersion: "fixture-v1",
  });
  const f = fixture("valid", [request.start(), request.finish("success")]);
  const result = await consolidateLearning(
    f.deps as never,
    { spaceId: "space", userId: "user" },
    revisions,
    f.config as never,
    now,
  );
  expect(result.tokens).toBeNull();
  expect(f.reviewExecution.update.mock.calls.at(-1)?.[0].data).not.toHaveProperty("reservedTokens");
});

it("uses a model-only bounded call, shares reservations and records every source revision without applying", async () => {
  vi.mocked(saveCuratorProposal).mockClear();
  const f = fixture();
  const result = await consolidateLearning(
    f.deps as never,
    { spaceId: "space", userId: "user" },
    revisions,
    f.config as never,
    now,
  );
  expect(result.tokens).toBe(50);
  expect(result.proposalIds).toHaveLength(1);
  expect(f.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      tools: "none",
      history: [],
      model: expect.objectContaining({ id: "local", maxTokens: 2000 }),
    }),
    expect.not.objectContaining({ executeTool: expect.anything() }),
  );
  expect(f.reviewExecution.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ reservedTokens: expect.any(Number) }),
    }),
  );
  expect(saveCuratorProposal).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      proposal: expect.objectContaining({
        operation: "consolidation",
        status: "pending",
        participatingRevisions: [
          { documentId: "doc1", revision: 1 },
          { documentId: "doc2", revision: 2 },
        ],
      }),
    }),
    now,
  );
});
it("rejects tool output and retains the budget reservation when usage is missing", async () => {
  vi.mocked(saveCuratorProposal).mockClear();
  const f = fixture("tool");
  const result = await consolidateLearning(
    f.deps as never,
    { spaceId: "space", userId: "user" },
    revisions,
    f.config as never,
    now,
  );
  expect(result).toEqual({ tokens: null, proposalIds: [], failed: true });
  expect(saveCuratorProposal).not.toHaveBeenCalled();
  expect(f.reviewExecution.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.not.objectContaining({ reservedTokens: expect.anything() }),
    }),
  );
});
it("does not consolidate across bots or call a model with no budget", async () => {
  const other = {
    ...revisions[1]!,
    scopeKey: { ...revisions[1]!.scopeKey, botId: "other" },
  } as DocumentRevision;
  expect(overlappingLearnedSkills([revisions[0]!, other])).toEqual([]);
  const f = fixture();
  await consolidateLearning(
    f.deps as never,
    { spaceId: "space", userId: "user" },
    revisions,
    { ...f.config, botDailyTokens: 0 } as never,
    now,
  );
  expect(f.execute).not.toHaveBeenCalled();
});
