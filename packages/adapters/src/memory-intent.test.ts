import type { AgentUsage } from "@ardurbot/adapter-kit";
import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveReviewerPin } from "./learning-pin.js";
import { proposeMemoryIntent } from "./memory-intent.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const actor = { spaceId: "space", userId: "user" } as Actor;
const pin = {
  runtimeKind: "pi",
  provider: "openai-compatible",
  modelId: "fixture",
  credentialId: "connection",
  revision: 0,
  effort: "medium",
};
function fixture(
  output = '{"proposals":[{"action":"save","kind":"preferences","content":"Use short answers."}]}',
  usage?: AgentUsage[],
) {
  const proposals: unknown[] = [];
  const bot = {
    id: "bot",
    spaceId: "space",
    userId: "user",
    modelProvider: pin.provider,
    modelId: pin.modelId,
    modelCredentialId: pin.credentialId,
    modelPinRevision: 0,
    thinkingLevel: "medium",
    runtimeKind: "pi",
    allowedModelDestinations: { mode: "any" } as unknown,
    thread: { id: "thread", historyCompactionGeneration: 0 },
  };
  const db = {
    $queryRaw: vi.fn(),
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    bot: { findFirst: vi.fn(async () => bot) },
    space: { findUnique: vi.fn(async () => ({ allowedModelDestinations: null })) },
    user: { findMany: vi.fn(async () => [{ id: actor.userId }]) },
    hostRegistration: { findUnique: vi.fn(async () => ({ userId: actor.userId })) },
    userModelCredential: {
      findFirst: vi.fn(async () => ({
        id: pin.credentialId,
        provider: pin.provider,
        secretId: "secret",
      })),
    },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "fixture" })),
    },
    botSecret: { findMany: vi.fn(async () => []) },
    spaceLearningConfig: { findUnique: vi.fn(async () => null) },
    reviewExecution: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }) => data),
      update: vi.fn(async ({ data }) => data),
    },
    thread: { updateMany: vi.fn(async () => ({ count: 1 })) },
    proposalEvidence: { create: vi.fn() },
    learningProposal: {
      create: vi.fn(async ({ data }) => {
        proposals.push(data);
        return data;
      }),
      findMany: vi.fn(async () => []),
    },
    learningGrant: { create: vi.fn() },
  };
  const memory = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    commit: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const runtime = {
    run: vi.fn(async function* () {
      yield { type: "text", text: output };
      for (const event of usage ?? [{ inputTokens: 100, outputTokens: 30 }])
        yield { type: "usage", ...event };
    }),
  };
  const deps = {
    prisma: { ...db, $transaction: async (work: (tx: typeof db) => unknown) => work(db) },
    memoryDocuments: memory,
    secretStore: {
      load: vi.fn(() =>
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "https://models.example.test/v1",
          reasoning: true,
        }),
      ),
    },
    runtime,
    resolvePin: vi.fn(async () => ({
      kind: "resolved",
      pin,
      provider: pin.provider,
      id: pin.modelId,
    })),
  };
  return {
    bot,
    db,
    memory,
    runtime,
    deps: deps as unknown as Parameters<typeof proposeMemoryIntent>[0],
    proposals,
  };
}
describe("explicit memory intents", () => {
  it("settles cumulative snapshots and their terminal receipt once", async () => {
    const request = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      inputSemantics: "total-with-cache-subsets",
      mappingVersion: "fixture-v1",
    });
    const started = request.start();
    const snapshot = request.snapshot({ input: 100, output: 30 });
    const f = fixture(undefined, [started, snapshot, request.finish("success"), snapshot]);
    await proposeMemoryIntent(f.deps, actor, {
      intent: "edit",
      text: "Use short answers.",
      requestId: "cumulative-fixture",
    });
    expect(f.db.reviewExecution.update).toHaveBeenLastCalledWith({
      where: expect.anything(),
      data: expect.objectContaining({ tokens: 130, reservedTokens: 130 }),
    });
  });

  it("keeps the reservation when request receipts contain no measured usage", async () => {
    const request = new RequestUsageCollector({
      provider: "fixture",
      model: "fixture",
      inputSemantics: "total-with-cache-subsets",
      mappingVersion: "fixture-v1",
    });
    const f = fixture(undefined, [request.start(), request.finish("success")]);
    await proposeMemoryIntent(f.deps, actor, {
      intent: "edit",
      text: "Use short answers.",
      requestId: "unmeasured-fixture",
    });
    expect(f.db.reviewExecution.update.mock.calls.at(-1)?.[0].data).not.toHaveProperty(
      "reservedTokens",
    );
  });

  it.each([{ mode: "local" }, { mode: "hosts", hosts: ["allowed.example.test"] }])(
    "refuses a remote edit under coordinator policy %j without dispatch",
    async (policy) => {
      const f = fixture();
      f.bot.allowedModelDestinations = policy;
      const resolvePin = vi.fn(resolveReviewerPin);
      f.deps.resolvePin = resolvePin;
      await expect(
        proposeMemoryIntent(f.deps, actor, {
          intent: "edit",
          text: "Use short answers.",
          requestId: "policy-fixture",
        }),
      ).rejects.toMatchObject({
        name: "RuntimePinError",
        problem: {
          code: "locality-denied",
          reason: "This bot may only run locally — change the pin or the space policy",
        },
      });
      expect(await resolvePin.mock.results[0]!.value).toMatchObject({
        kind: "problem",
        code: "locality-denied",
      });
      expect(f.runtime.run).not.toHaveBeenCalled();
      expect(f.db.reviewExecution.create).not.toHaveBeenCalled();
      expect(f.proposals).toHaveLength(0);
    },
  );
  it("allows an edit at a coordinator's explicitly permitted host", async () => {
    const f = fixture();
    f.bot.allowedModelDestinations = { mode: "hosts", hosts: ["models.example.test"] };
    f.deps.resolvePin = resolveReviewerPin;
    expect(
      await proposeMemoryIntent(f.deps, actor, {
        intent: "edit",
        text: "Use short answers.",
        requestId: "allowed-fixture",
      }),
    ).toHaveLength(1);
    expect(f.runtime.run).toHaveBeenCalledOnce();
  });
  it.each(["claude-code", "codex-app-server"])(
    "refuses unsupported %s memory reviews before dispatch or reservation",
    async (kind) => {
      const f = fixture();
      f.bot.runtimeKind = kind;
      f.bot.modelProvider = kind === "claude-code" ? "anthropic" : "openai-codex";
      f.bot.modelCredentialId = `native:${kind}`;
      f.deps.resolvePin = resolveReviewerPin;
      const runtime = new PiAgentRuntime();
      const run = vi.spyOn(runtime, "run");
      f.deps.runtime = runtime;
      await expect(
        proposeMemoryIntent(f.deps, actor, {
          intent: "edit",
          text: "Use short answers.",
          requestId: "native-fixture",
        }),
      ).rejects.toThrow(
        "Memory review is not available with Claude Code or Codex yet; import memory or edit a document directly.",
      );
      expect(run).not.toHaveBeenCalled();
      expect(f.db.reviewExecution.create).not.toHaveBeenCalled();
      expect(f.proposals).toHaveLength(0);
      expect(
        await proposeMemoryIntent(f.deps, actor, {
          intent: "import",
          text: "Use short answers.",
          requestId: "native-import-fixture",
        }),
      ).toHaveLength(1);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("imports grouped text as pending proposals without a model, memory write, or grant", async () => {
    const f = fixture();
    const proposals = await proposeMemoryIntent(f.deps, actor, {
      intent: "import",
      text: "Profile\n- I study plants.\nPreferences\n- Use plain language.\nTopics\n- Garden planning",
      requestId: "import-fixture",
    });
    expect(proposals.map((p) => [p.documentKind, p.status, p.operation])).toEqual([
      ["profile", "pending", "memory-import"],
      ["preferences", "pending", "memory-import"],
      ["topic", "pending", "memory-import"],
    ]);
    expect(f.runtime.run).not.toHaveBeenCalled();
    expect(f.memory.commit).not.toHaveBeenCalled();
    expect(f.memory.update).not.toHaveBeenCalled();
    expect(f.memory.delete).not.toHaveBeenCalled();
    expect(f.db.learningGrant.create).not.toHaveBeenCalled();
    expect(f.db.proposalEvidence.create.mock.calls[0]![0].data.body.excerpt).toBe(
      "Review the memory I pasted for import.",
    );
  });
  it("runs the coordinator with no tools and returns an approval card", async () => {
    const f = fixture();
    const proposals = await proposeMemoryIntent(f.deps, actor, {
      intent: "edit",
      text: "Use short answers.",
      requestId: "edit-fixture",
    });
    expect(f.runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot",
        threadId: "thread",
        tools: "none",
        history: [],
        prompt: expect.stringContaining('"intent":"memory-edit"'),
      }),
      expect.anything(),
    );
    expect(proposals[0]).toMatchObject({
      operation: "memory-edit",
      status: "pending",
      proposedContent: "Use short answers.",
      scope: actor,
    });
    expect(f.memory.commit).not.toHaveBeenCalled();
    expect(f.db.learningGrant.create).not.toHaveBeenCalled();
  });
  it("rejects a foreign target before persisting proposals", async () => {
    const f = fixture(
      '{"proposals":[{"action":"delete","documentId":"foreign","expectedRevision":1,"content":""}]}',
    );
    await expect(
      proposeMemoryIntent(f.deps, actor, {
        intent: "edit",
        text: "Forget that.",
        requestId: "foreign-fixture",
      }),
    ).rejects.toThrow();
    expect(f.proposals).toHaveLength(0);
    expect(f.memory.delete).not.toHaveBeenCalled();
  });
  it("rejects attempted tool calls and changed source history", async () => {
    const f = fixture();
    f.runtime.run.mockImplementation(async function* () {
      yield { type: "tool", text: "" } as never;
    });
    await expect(
      proposeMemoryIntent(f.deps, actor, {
        intent: "edit",
        text: "Remember this.",
        requestId: "tool-fixture",
      }),
    ).rejects.toThrow();
    expect(f.proposals).toHaveLength(0);
    const changed = fixture();
    changed.db.thread.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      proposeMemoryIntent(changed.deps, actor, {
        intent: "import",
        text: "A fact.",
        requestId: "cleared-fixture",
      }),
    ).rejects.toThrow();
    expect(changed.proposals).toHaveLength(0);
  });
  it("checks membership before reading memory or resolving the coordinator", async () => {
    const f = fixture();
    f.db.spaceMember.findUnique.mockResolvedValue(null as never);
    await expect(
      proposeMemoryIntent(f.deps, actor, {
        intent: "import",
        text: "A fact.",
        requestId: "member-fixture",
      }),
    ).rejects.toThrow();
    expect(f.memory.list).not.toHaveBeenCalled();
    expect(f.db.bot.findFirst).not.toHaveBeenCalled();
  });
});
