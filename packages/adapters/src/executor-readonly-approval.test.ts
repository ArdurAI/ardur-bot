// Admission is verified separately; these fixtures isolate tool policy and replay.
vi.mock("./context/concurrency.js", () => ({
  claimBotRun: (prisma: unknown, input: { claim: (tx: unknown) => Promise<unknown> }) =>
    input.claim(prisma),
}));
// Ledger transactions have disposable-PostgreSQL coverage; this fixture isolates approval policy.
vi.mock("./run-usage.js", () => ({ recordRunUsage: vi.fn(async () => null) }));

import type {
  AdapterContext,
  AgentRunRequest,
  AutoReviewProvider,
  ConnectorCall,
  ConnectorEvent,
  ConnectorTool,
} from "@ardurbot/adapter-kit";
import type { SpaceToolPolicies } from "@ardurbot/contracts";
import type { ActionApprovalRule } from "@ardurbot/core";
import {
  approvalEffectKey,
  toolEffectIdempotencyKey,
} from "@ardurbot/core/node/approval-effect-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isApprovalPausedResult } from "./approval-effect.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";
import { approvalRequestRoute } from "./remote-execution.js";
import { recordRunUsage } from "./run-usage.js";
import { startScoreboardTrace } from "./scoreboard-trace.js";

vi.mock("./runtimes/native-host.js", () => ({ nativeHostOwner: async () => true }));

const fleetComputer = vi.hoisted(() => ({ kind: "desktop" }));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: fleetComputer.kind }),
}));

const reviewMock = vi.fn();
const autoReviewProvider: AutoReviewProvider = {
  describe: () => ({
    id: "mock",
    contractVersion: "1",
    adapterVersion: "0.1.0",
    capabilities: { offline: true, keyless: true },
  }),
  review: reviewMock,
};

type Effect = {
  id: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
  runId?: string;
};

function fixture({
  name = "demo_get_item",
  catalog = false,
  rules = [] as ActionApprovalRule[],
  autoReview = false,
  trigger = "user",
  secrets = [] as string[],
  prompt = "Read the item",
  bot = {
    name: "Assistant",
    title: "Assistant",
    description: "Test assistant",
  },
  shutdownSignal,
  integration = false,
  host = false,
}: {
  name?: string;
  catalog?: boolean;
  rules?: ActionApprovalRule[];
  autoReview?: boolean;
  trigger?: string;
  secrets?: string[];
  prompt?: string;
  bot?: { name: string; title: string; description: string };
  shutdownSignal?: AbortSignal;
  integration?: boolean;
  host?: boolean;
} = {}) {
  const tool: ConnectorTool = {
    name,
    description: "Read an item",
    readOnly: true,
    inputSchema: host
      ? {
          type: "object",
          properties: { args: { type: "array", items: { type: "string" } } },
          required: ["args"],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
    route: {
      connectorId: integration ? "mcp" : "demo",
      resourceId: "resource-1",
      resourceRevision: 1,
      toolName: name,
    },
  };
  const grant = {
    allowAllTools: false,
    needsReview: false,
    allowedTools: [name],
    server: {
      enabled: true,
      catalogId: "github",
      transport: host ? "host-cli" : "remote-http",
      connectionState: "connected",
      revision: 1,
      spaceAllowedTools: [name],
      spaceToolPolicies: {} as SpaceToolPolicies,
      manifest: {
        capturedAt: "2026-09-23T00:00:00.000Z",
        serverVersion: null,
        account: host ? "fixture-account" : null,
        workspace: null as string | null,
        tools: [
          { id: name, description: "Synthetic test tool", inputSchemaDigest: "a".repeat(64) },
        ],
      },
    },
  };
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const run = {
    createdAt: new Date("2026-09-24T12:00:00Z"),
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger,
    leaseFence: 0,
  };
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const modelCredential = {
    id: "model-connection",
    userId: "user-1",
    provider: "xai",
    secretId: "model-secret",
    label: "xai",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const prisma = {
    delegationRoot: { findUnique: vi.fn(async () => null) },
    space: {
      findUnique: vi.fn(async () => ({ allowedModelDestinations: null })),
      findUniqueOrThrow: vi.fn(async () => ({
        botInstructions: "",
        botInstructionsAuthorId: null,
        botInstructionsRevision: 0,
      })),
    },
    user: { findUniqueOrThrow: vi.fn(async () => ({ displayName: "", workType: "" })) },

    computer: {
      findFirstOrThrow: vi.fn(async () => ({
        id: "computer-1",
        scope: "dedicated",
        kind: fleetComputer.kind,
      })),
    },
    instanceIdentity: { findUnique: vi.fn(async () => null) },
    deviceApprovalBinding: { findUnique: vi.fn(async () => null) },
    botMcpServer: { findFirst: vi.fn(async () => grant) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findFirst: vi.fn(async () => ({
        computer: { id: "computer-1", kind: "desktop", providerRef: "/workspace" },
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: bot.name,
        title: bot.title,
        description: bot.description,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated", kind: fleetComputer.kind },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: { findUniqueOrThrow: vi.fn(async () => ({ id: run.threadId, groupId: null })) },
    message: { findMany: vi.fn(async () => []) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: {
      findFirst: vi.fn(async () => ({
        credential: modelCredential,
        modelId: "grok-4.6",
        isDefault: true,
      })),
    },
    userModelCredential: { findFirst: vi.fn(async () => modelCredential) },
    secret: { findFirst: vi.fn(async () => ({ id: "model-secret", ciphertext: "test-key" })) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => rules) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: autoReview })) },
    externalEffect,
  };
  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const execute = vi.fn(async function* (
    call: ConnectorCall,
    _context: AdapterContext,
  ): AsyncGenerator<ConnectorEvent> {
    yield { type: "result" as const, data: { item: call.args.id } };
  });
  let calls: Array<{ args: Record<string, unknown>; executionId: string }> = [
    {
      args: host
        ? { args: ["issue", "list"] }
        : name === "shell"
          ? { command: "pnpm test" }
          : { id: "item-1" },
      executionId: "call-1",
    },
  ];
  const cwd = { value: "/workspace" };
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(
        catalog ? "demo_execute_tool" : name,
        catalog ? { id: `resource-1:${name}`, arguments: call.args } : call.args,
        call.executionId,
      );
      results.push(result);
      if (isApprovalPausedResult(result)) return;
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma,
    secretStore: { load: () => "test-key" },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () =>
        catalog
          ? [
              {
                name: "demo_execute_tool",
                description: "Execute a catalog tool",
                inputSchema: { type: "object" },
                route: { connectorId: "demo", toolName: "__catalog_execute" },
              },
            ]
          : [tool],
      resolveCall: async (call: ConnectorCall) =>
        catalog ? resolveCatalogCall(call, catalogEntries([tool])) : undefined,
      execute,
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      resolveCommandCwd: async () => cwd.value,
    },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), pauseRunForInput, finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
    autoReview: autoReviewProvider,
    shutdownSignal,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return {
    cwd,
    grant,
    effects,
    results,
    execute,
    pauseRunForInput,
    setCalls(next: typeof calls) {
      calls = next;
    },
    async run() {
      vi.mocked(recordRunUsage).mockClear();
      run.status = "queued";
      await executor.continueRun(run.id, "worker-1");
      expect(runtimeRun).toHaveBeenCalled();
      expect(prisma.attempt.update).not.toHaveBeenCalled();
      expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
      expect(recordRunUsage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: run.id }),
        expect.objectContaining({
          request: expect.objectContaining({
            purpose: "main",
            categories: expect.objectContaining({ logicalInput: null, output: null }),
            collection: expect.objectContaining({
              scope: "runtime-call",
              availability: "unavailable",
            }),
          }),
        }),
      );
    },
  };
}

describe("connector read-only metadata and approval enforcement", () => {
  beforeEach(() => {
    reviewMock.mockReset();
    fleetComputer.kind = "desktop";
  });

  it.each([
    {
      result: { isError: true, content: [{ type: "text", text: "Synthetic MCP failure" }] },
      outcome: "failed",
    },
    { result: { isError: true, content: [] }, outcome: "failed" },
    { result: { details: { error: { message: "Synthetic wrapped failure" } } }, outcome: "failed" },
    {
      result: { isError: false, content: [{ type: "text", text: "Synthetic success" }] },
      outcome: "success",
    },
  ])(
    "traces returned connector result $outcome without changing its payload",
    async ({ result, outcome }) => {
      const f = fixture({ integration: true, name: "synthetic_get_item" });
      f.grant.server.spaceToolPolicies = { synthetic_get_item: "allow" };
      f.execute.mockImplementation(async function* () {
        yield { type: "result", data: result };
      });
      const trace = startScoreboardTrace();
      try {
        await f.run();
        expect(f.execute).toHaveBeenCalledOnce();
        expect(f.results).toEqual([result]);
        expect(
          trace.snapshot().points.filter((point) => point.boundary === "tool.finished"),
        ).toEqual([expect.objectContaining({ operationId: "call-1", outcome })]);
      } finally {
        trace.stop();
      }
    },
  );

  it.each(["ssh", "remote-docker", "kubernetes"])(
    "retains Ask-first approval on a %s computer",
    async (kind) => {
      fleetComputer.kind = kind;
      const f = fixture({
        name: "shell",
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "shell" }],
      });
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  describe.each([false, true])("host command catalog = %s", (catalog) => {
    it("asks for a read command despite an allow rule and passes only the bound snapshot after approval", async () => {
      const f = fixture({
        name: "execute_command",
        catalog,
        integration: true,
        host: true,
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "execute_command" }],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [
            expect.objectContaining({
              text: "'gh' 'issue' 'list'",
              preformatted: true,
              detail: "Identity: fixture-account\nWorking directory: '/workspace'",
            }),
          ],
        }),
      );
      const snapshot = approvalRequestRoute(f.effects[0]!.request)?.hostCommand;
      expect(snapshot).toMatchObject({
        argv: ["gh", "issue", "list"],
        identity: "fixture-account",
        cwd: "/workspace",
      });
      f.effects[0]!.status = "approved";
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({ args: { args: ["issue", "list"] } }),
        expect.objectContaining({ hostCommandApproval: snapshot }),
      );
      expect(f.effects[0]!.status).toBe("completed");
    });
    it.each(["argv", "program", "identity", "workspace", "cwd", "legacy", "transport"])(
      "refuses a resumed approval after %s changes",
      async (changed) => {
        const f = fixture({ name: "execute_command", catalog, integration: true, host: true });
        await f.run();
        f.effects[0]!.status = "approved";
        if (changed === "argv")
          f.setCalls([
            {
              args: { args: ["issue", "create", "--title", "Unapproved"] },
              executionId: "new-call",
            },
          ]);
        if (changed === "program") f.grant.server.catalogId = "gitlab";
        if (changed === "transport") f.grant.server.transport = "remote-http";
        if (changed === "identity") f.grant.server.manifest.account = "other-fixture-account";
        if (changed === "workspace") f.grant.server.manifest.workspace = "other-workspace";
        if (changed === "cwd") f.cwd.value = "/other-workspace";
        if (changed === "legacy") delete approvalRequestRoute(f.effects[0]!.request)!.hostCommand;
        await f.run();
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.results.at(-1)).toEqual({
          error: "This command changed or has no bound approval. Review it again.",
        });
      },
    );
  });

  it.each(["shell", "write_file"])(
    "forces owner approval for webhook-triggered %s despite an allow rule",
    async (name) => {
      const f = fixture({
        name,
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
      });
      await f.run();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    },
  );

  describe.each([false, true])("catalog = %s", (catalog) => {
    it.each(["tool", "connector"] as const)(
      "honors an explicit %s approval rule",
      async (matchKind) => {
        const f = fixture({
          catalog,
          autoReview: true,
          rules: [
            {
              effect: "require_approval",
              matchKind,
              matchValue: matchKind === "tool" ? "demo_get_item" : "demo",
            },
          ],
        });
        await f.run();
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.pauseRunForInput).toHaveBeenCalledOnce();
        expect(f.pauseRunForInput).toHaveBeenCalledWith(
          expect.objectContaining({
            blocks: [expect.objectContaining({ kind: "ask", approvalEffectId: f.effects[0]!.id })],
          }),
        );
        expect(isApprovalPausedResult(f.results[0])).toBe(true);
        expect(reviewMock).not.toHaveBeenCalled();
      },
    );

    it("replays the approved arguments once and returns the result on retry", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          args: { id: "item-1" },
          executionId: approvalEffectKey("run-1", "demo_get_item", { id: "item-1" }),
        }),
        expect.anything(),
      );
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("executes a later identical-args call after an approved replay when approval is not required by default", async () => {
      const args = { id: "item-1" };
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([
        { args, executionId: "call-2" },
        { args, executionId: "call-3" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.effects).toHaveLength(2);
      expect(f.effects[0]?.idempotencyKey).toBe(approvalEffectKey("run-1", "demo_get_item", args));
      expect(f.effects[1]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", args, 1),
      );
      expect(f.results.slice(1)).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("honors a persisted denial on a new tool call id", async () => {
      const f = fixture({
        catalog,
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" }],
      });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "denied";
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toEqual({ error: "User denied this action." });
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("consumes the saved approval after the user chooses always allow", async () => {
      const rules: ActionApprovalRule[] = [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
      ];
      const f = fixture({ catalog, rules });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      rules[0]!.effect = "always_allow";
      f.setCalls([{ args: { id: "model-reconstructed" }, executionId: "call-2" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
      expect(f.effects).toHaveLength(1);
      expect(f.effects[0]!.status).toBe("completed");
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    });

    it("allows ordinary reads without approval or automatic review", async () => {
      const f = fixture({ catalog, autoReview: true });
      f.setCalls([
        { args: { id: "item-1" }, executionId: "call-1" },
        { args: { id: "item-1" }, executionId: "call-2" },
      ]);
      await f.run();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(f.results).toEqual([{ item: "item-1" }, { item: "item-1" }]);
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("replays a non-approval connector effect when the tool-call id changes", async () => {
      const f = fixture({ catalog });
      f.setCalls([{ args: { id: "item-1" }, executionId: "call-1" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects[0]?.idempotencyKey).toBe(
        toolEffectIdempotencyKey("run-1", "demo_get_item", { id: "item-1" }),
      );

      f.setCalls([{ args: { id: "item-1" }, executionId: "call-new" }]);
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.effects).toHaveLength(1);
      expect(f.results.at(-1)).toEqual({ item: "item-1" });
    });

    it("keeps an explicit allow rule ahead of automatic review", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it("forces owner approval for webhook-triggered writes despite an allow rule", async () => {
      const f = fixture({
        catalog,
        name: "demo_send_message",
        trigger: "webhook",
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "demo_send_message" }],
      });
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    });

    it.each(["ask", "error", "pass"] as const)(
      "honors automatic review %s despite a read-only hint",
      async (decision) => {
        reviewMock.mockResolvedValue({
          decision,
          reason: "Review result",
          model: "scripted/checker",
        });
        const f = fixture({ catalog, name: "demo_send_message", autoReview: true });
        await f.run();
        expect(reviewMock).toHaveBeenCalledOnce();
        expect(reviewMock).toHaveBeenCalledWith(
          expect.objectContaining({ toolName: "demo_send_message", connectorKind: "demo" }),
          expect.objectContaining({ runId: "run-1" }),
        );
        expect(f.effects[0]?.reviewDecision).toBe(decision);
        expect(f.execute).toHaveBeenCalledTimes(decision === "pass" ? 1 : 0);
        expect(f.pauseRunForInput).toHaveBeenCalledTimes(decision === "pass" ? 0 : 1);
      },
    );

    it("redacts run secrets from automatic review task and bot context", async () => {
      reviewMock.mockResolvedValue({ decision: "pass", model: "mock" });
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        secrets: ["super-secret-token"],
        prompt: "Send mail with super-secret-token",
        bot: {
          name: "Mail",
          title: "Helper",
          description: "Uses super-secret-token",
        },
      });
      await f.run();
      expect(reviewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userTask: "Send mail with [redacted]",
          botDescription: "Mail: Helper\nUses [redacted]",
        }),
        expect.objectContaining({ runId: "run-1" }),
      );
    });

    it("does not persist a review decision when the run is cancelled", async () => {
      const shutdown = new AbortController();
      reviewMock.mockImplementation(async () => {
        shutdown.abort();
        return { decision: "error", reason: "Checker timed out or failed.", model: "mock" };
      });
      const f = fixture({
        catalog,
        name: "demo_send_message",
        autoReview: true,
        shutdownSignal: shutdown.signal,
      });
      await f.run();
      expect(f.effects[0]?.reviewDecision).toBeUndefined();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    });
  });
});

describe("catalog policy at the executor gate", () => {
  it.each([
    [false, "user"],
    [true, "user"],
    [false, "webhook"],
    [true, "webhook"],
  ] as const)(
    "runs owner-allowed reads without pausing or auto-review (lazy=%s, trigger=%s)",
    async (catalog, trigger) => {
      const name = "synthetic_fetch_item";
      const f = fixture({ integration: true, catalog, name, autoReview: true, trigger });
      f.grant.server.spaceToolPolicies = { [name]: "allow" };
      reviewMock.mockReset();
      await f.run();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
      expect(reviewMock).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "still pauses writes with a forged owner allow and names the manifest action (lazy=%s)",
    async (catalog) => {
      const name = "synthetic_create_comment";
      const f = fixture({ integration: true, catalog, name });
      f.grant.server.spaceToolPolicies = { [name]: "allow" };
      f.grant.server.manifest.tools[0]!.description =
        "Create a pull request comment. Includes a comment body.";
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: [
            expect.objectContaining({
              text: "Save this to GitHub?",
              detail: `${name}\nGitHub\nCreate a pull request comment.`,
              actions: [
                { id: "allow", label: "Save" },
                { id: "deny", label: "Cancel", outcome: "cancelled" },
              ],
            }),
          ],
        }),
      );
    },
  );
  it.each([false, true])(
    "requires owner approval despite an allow rule and auto-review (lazy=%s)",
    async (catalog) => {
      const name = "synthetic_get_item";
      const f = fixture({
        integration: true,
        catalog,
        name,
        autoReview: true,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: name }],
      });
      reviewMock.mockReset();
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(isApprovalPausedResult(f.results[0])).toBe(true);
      expect(reviewMock).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "rejects revoked grants even during an approved replay (lazy=%s)",
    async (catalog) => {
      const f = fixture({ integration: true, catalog });
      await f.run();
      expect(f.effects).toHaveLength(1);
      f.effects[0]!.status = "approved";
      f.grant.allowedTools = [];
      await f.run();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.results.at(-1)).toMatchObject({
        error: expect.stringContaining("no longer granted"),
      });
    },
  );
});

it("persists an uncertain integration delivery and never dispatches its approved replay twice", async () => {
  const f = fixture({ integration: true, name: "mcp__demo__synthetic_write" });
  await f.run();
  expect(f.effects).toHaveLength(1);
  f.effects[0]!.status = "approved";
  f.execute.mockImplementation(async function* () {
    yield { type: "error" as const, message: "Delivery could not be confirmed", uncertain: true };
  });
  await f.run();
  expect(f.effects[0]!.status).toBe("uncertain");
  expect(f.effects[0]!.result).toEqual({
    error: "Delivery could not be confirmed",
    uncertain: true,
  });
  expect(f.execute).toHaveBeenCalledTimes(1);
  await f.run();
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it.each(["bot-1", "different-bot"])(
  "resolves a read exception only for its named bot (%s)",
  async (botId) => {
    const f = fixture({
      rules: [
        { effect: "require_approval", matchKind: "tool", matchValue: "demo_get_item" },
        { effect: "always_allow", matchKind: "tool", matchValue: "demo_get_item", botId },
      ],
    });
    await f.run();
    if (botId === "bot-1") {
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.pauseRunForInput).not.toHaveBeenCalled();
    } else {
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
    }
  },
);
