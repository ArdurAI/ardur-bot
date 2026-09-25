import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, createThreadMessage } from "@ardurbot/db";
import { FakeSandboxProvider } from "../../../../adapters/src/fake-sandbox.js";
import { compactHistory } from "../../../../adapters/src/history-compaction.js";
import { McpConnector } from "../../../../adapters/src/mcp-connector.js";
import { runtimeSession } from "../../../../adapters/src/runtimes/runtime-session.js";
import { EncryptedSecretStore } from "../../../../adapters/src/secrets.js";
import { GraphileJobPublisher } from "../../../../adapters/src/wakeup.js";
import { DesktopSandboxProvider } from "../../../../host-runtime/src/desktop-sandbox.js";
import { RuntimeQueue } from "../../../../host-runtime/src/runtimes/native-process.js";
import { GOLD_MODEL, goldRuntime } from "../faults/auxiliary.js";
import { contentDigest } from "../manifest.js";
import { denyExternalTcp } from "../replay/offline.js";
import { isOwnedReplayDatabase } from "../replay/postgres.js";
import type { MatrixResult, matrixPlan } from "./catalog.js";
import { COMPUTER_RUNNERS, runComputerLifecycle } from "./computer.js";
import { seedScope } from "./durable.js";
import { prefixExperiment, rateLimitExperiment, streamingExperiment } from "./provider.js";
import { GOLD_SUMMARY, gradeGoldProbes } from "./schedules.js";

export async function compactionExperiment(db: ReturnType<typeof createDb>): Promise<MatrixResult> {
  const jobs = new GraphileJobPublisher(db.pool);
  const samples = [];
  try {
    for (const variant of [
      "full-history",
      "compacted",
      "summary-timeout",
      "summary-truncation",
      "critical-omission",
      "concurrent-history-edit",
    ]) {
      const context = await seedScope(db.prisma);
      await createThreadMessage(db.prisma, {
        threadId: context.threadId,
        role: "user",
        blocks: [{ kind: "text", text: GOLD_SUMMARY }],
      });
      let failure = false;
      let beforeResult: (() => Promise<void>) | undefined;
      if (variant === "summary-timeout")
        beforeResult = async () => {
          throw new Error("Injected summary timeout");
        };
      if (variant === "concurrent-history-edit")
        beforeResult = async () => {
          await db.prisma.thread.update({
            where: { id: context.threadId },
            data: {
              historyCompactionGeneration: { increment: 1 },
              historyCompactionSummary: null,
              historyCompactedUpToSeq: null,
            },
          });
        };
      const summary =
        variant === "summary-truncation"
          ? "x".repeat(20001)
          : variant === "critical-omission"
            ? JSON.stringify({ fact: "Budget is 120 units." })
            : GOLD_SUMMARY;
      if (variant !== "full-history")
        try {
          await compactHistory(
            {
              prisma: db.prisma,
              jobs,
              runtime: goldRuntime(summary, beforeResult),
              memoryProviders: { resolve: async () => null },
              resolveModel: async () => GOLD_MODEL,
            },
            context.threadId,
          );
        } catch {
          failure = true;
        }
      const row = await db.prisma.thread.findUniqueOrThrow({ where: { id: context.threadId } });
      const messages = await db.prisma.message.findMany({
        where: { threadId: context.threadId },
        select: { blocks: true },
      });
      const retainedHistory = messages
        .flatMap((message) => (Array.isArray(message.blocks) ? message.blocks : []))
        .map((block) =>
          block && typeof block === "object" && "text" in block ? String(block.text) : "",
        )
        .join("\n");
      const mustReject = [
        "summary-timeout",
        "summary-truncation",
        "concurrent-history-edit",
      ].includes(variant);
      const committed = row.historyCompactionSummary;
      const probes = gradeGoldProbes(committed ?? retainedHistory);
      samples.push({
        variant,
        failure,
        replaced: row.historyCompactedUpToSeq !== null,
        probes,
        rejected: !mustReject || (row.historyCompactedUpToSeq === null && !committed),
        omissionCommitted:
          variant === "critical-omission" &&
          committed !== null &&
          !Object.values(probes).every(Boolean),
        historyRetained: retainedHistory.includes(GOLD_SUMMARY),
        criticalFactsPreserved: Object.values(probes).every(Boolean),
      });
    }
    const checks = {
      noStaleOrFailedReplacement: samples
        .filter((row) =>
          ["summary-timeout", "summary-truncation", "concurrent-history-edit"].includes(
            row.variant,
          ),
        )
        .every((row) => row.rejected && row.historyRetained),
      // Production commits the model text without checking the gold probes.
      omissionNotCommitted: samples.every((row) => !row.omissionCommitted),
      criticalFactRetention: samples.every((row) => row.criticalFactsPreserved),
    };
    return {
      id: "O4",
      experiment: "O4",
      tier: "T1",
      status: Object.values(checks).every(Boolean) ? "passed" : "finding",
      checks,
      measurements: { samples, summaryUsage: null, liveRecallQuality: null },
      coverage: [
        "production-compactHistory",
        "real-postgresql",
        "generation-CAS",
        "structured-gold-probes",
        "injected-summary-failure",
      ],
      gaps: [
        "Synthetic summarizer tests commit mechanics and gold omissions; it cannot establish live summary quality or actual summary cost.",
      ],
    };
  } finally {
    await jobs.close();
  }
}

export async function connectorExperiment(
  db: ReturnType<typeof createDb>,
  counts: readonly number[],
): Promise<MatrixResult> {
  const samples = [];
  for (const count of counts) {
    if (![0, 10, 50].includes(count)) throw new Error("Invalid connector count");
    const context = { ...(await seedScope(db.prisma)), toolAccessMode: "all" as const };
    for (let i = 0; i < count; i++)
      await db.prisma.mcpServer.create({
        data: {
          id: `mcp-${context.botId}-${i}`,
          spaceId: context.spaceId,
          userId: context.userId,
          slug: `fixture-${i}`,
          name: "Synthetic connector",
          transport: "streamable_http",
          endpoint: `https://matrix.example.test/${i}`,
          assignments: {
            create: {
              botId: context.botId,
              spaceId: context.spaceId,
              userId: context.userId,
              allowedTools: ["read"],
              allowAllTools: false,
            },
          },
        },
      });
    let calls = 0;
    let initializations = 0;
    let revision = 1;
    let transport: "fast" | "slow" | "paginated" | "unavailable" = "fast";
    let executions = 0;
    const connector = new McpConnector(
      db.prisma,
      new EncryptedSecretStore("synthetic-matrix-key"),
      {
        network: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
          fetch: async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            if (request.method !== "POST") return new Response(null, { status: 405 });
            const body = (await request.json()) as {
              id?: number;
              method?: string;
              params?: { cursor?: string };
            };
            const respond = (result: unknown) =>
              Response.json({ jsonrpc: "2.0", id: body.id, result });
            if (body.method === "initialize") {
              initializations++;
              return respond({
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "matrix", version: String(revision) },
              });
            }
            if (body.method === "tools/list") {
              calls++;
              if (transport === "unavailable") throw new Error("Synthetic unavailable connector");
              if (transport === "slow") await delay(10);
              return respond({
                ...(transport === "paginated" && !body.params?.cursor
                  ? { nextCursor: "page-2" }
                  : {}),
                tools: [
                  {
                    name: body.params?.cursor ? "ungranted_page_2" : "read",
                    description: `schema-${revision}`,
                    inputSchema: { type: "object", properties: { revision: { const: revision } } },
                  },
                ],
              });
            }
            if (body.method === "tools/call") {
              if (transport === "unavailable") throw new Error("Synthetic unavailable connector");
              executions++;
              return respond({ content: [{ type: "text", text: "fixture" }] });
            }
            return new Response(null, { status: 202 });
          },
        },
      },
    );
    try {
      const first = await connector.discoverTools(context);
      const firstCalls = calls;
      const second = await connector.discoverTools(context);
      const secondCalls = calls - firstCalls;
      const phases = [];
      for (const variant of ["slow", "paginated", "unavailable"] as const) {
        transport = variant;
        const started = performance.now();
        const previousCalls = calls;
        const tools = await connector.discoverTools(context);
        const requiredResult = [];
        if (variant === "unavailable" && first[0]) {
          for await (const item of connector.execute(
            {
              executionId: "matrix-required",
              tool: first[0].name,
              args: {},
              route: first[0].route,
            },
            context,
          ))
            requiredResult.push(item.type);
        }
        phases.push({
          variant,
          tools: tools.length,
          listRequests: calls - previousCalls,
          elapsedMs: performance.now() - started,
          requiredResult,
        });
      }
      transport = "fast";
      const sessionsBefore = initializations;
      revision++;
      await db.prisma.mcpServer.updateMany({
        where: { spaceId: context.spaceId },
        data: { revision: { increment: 1 } },
      });
      const changed = await connector.discoverTools(context);
      await db.prisma.botMcpServer.updateMany({
        where: { botId: context.botId },
        data: { allowedTools: [] },
      });
      const revoked = await connector.discoverTools(context);
      const callsBeforeRevokedExecution = executions;
      const denied = [];
      if (first[0])
        for await (const item of connector.execute(
          { executionId: "matrix-revoked", tool: first[0].name, args: {}, route: first[0].route },
          context,
        ))
          denied.push(item.type);
      samples.push({
        count,
        firstCalls,
        secondCalls,
        initializations,
        stableCatalog: contentDigest(first) === contentDigest(second),
        schemaChanged: count === 0 || contentDigest(first) !== contentDigest(changed),
        sessionsInvalidated: count === 0 || initializations > sessionsBefore,
        revoked: revoked.length === 0,
        executionDenied:
          count === 0 || (denied.includes("error") && executions === callsBeforeRevokedExecution),
        transportCases: phases,
        paginationComplete:
          count === 0 ||
          phases.find((row) => row.variant === "paginated")?.listRequests === 2 * count,
        unavailableSafe:
          count === 0 ||
          phases.find((row) => row.variant === "unavailable")?.requiredResult.includes("error") ===
            true,
      });
    } finally {
      await connector.close();
    }
  }
  const checks = {
    catalogStable: samples.every((row) => row.stableCatalog),
    liveGrantRevocation: samples.every((row) => row.revoked),
    schemaInvalidated: samples.every((row) => row.schemaChanged && row.sessionsInvalidated),
    executionRevocationFence: samples.every((row) => row.executionDenied),
    paginatedTransport: samples.every((row) => row.paginationComplete),
    requiredUnavailableFails: samples.every((row) => row.unavailableSafe),
  };
  return {
    id: "O6",
    experiment: "O6",
    tier: "T1",
    status: Object.values(checks).every(Boolean) ? "passed" : "finding",
    checks,
    measurements: { samples },
    coverage: [
      "real-McpConnector-and-McpSession",
      "durable-grants-and-schema-revisions",
      "injected-transport-fixture",
    ],
    gaps: [
      "All-tools discovery isolates catalog scaling; lazy catalog and executor-level required-versus-optional task outcomes still require full-stack acceptance.",
    ],
  };
}

export async function nativeBindingExperiment(
  db: ReturnType<typeof createDb>,
): Promise<MatrixResult> {
  const context = await seedScope(db.prisma);
  const pin = {
    runtimeKind: "codex-app-server" as const,
    provider: "openai",
    modelId: "fixture-native",
    effort: "low",
    credentialId: "native:codex-app-server",
    revision: 1,
  };
  const task = await db.prisma.task.create({
    data: {
      spaceId: context.spaceId,
      userId: context.userId,
      botId: context.botId,
      threadId: context.threadId,
      status: "completed",
      prompt: "Synthetic native turn",
    },
  });
  const run = await db.prisma.run.create({
    data: {
      spaceId: context.spaceId,
      userId: context.userId,
      botId: context.botId,
      threadId: context.threadId,
      taskId: task.id,
      status: "completed",
      trigger: "user",
      runtimePin: pin,
    },
  });
  const input = { ...context, runId: run.id, computerId: null, instructions: "fixture", pin };
  const first = await runtimeSession(db.prisma, input);
  await db.prisma.run.update({
    where: { id: run.id },
    data: {
      runtimeInfo: {
        runtimeKind: "codex-app-server",
        sessionId: "fixture-session",
        binding: first.binding,
      },
    },
  });
  const samples = [];
  for (const change of [
    { name: "resumed-turn", input },
    { name: "pin-change", input: { ...input, pin: { ...pin, effort: "high" } } },
    { name: "instruction-change", input: { ...input, instructions: "revised" } },
    { name: "history-generation", input: { ...input, historyGeneration: 1 } },
    { name: "computer-change", input: { ...input, computerId: "other-fixture" } },
  ]) {
    const result = await runtimeSession(db.prisma, change.input);
    samples.push({
      variant: change.name,
      resumed: Boolean(result.previous),
      binding: result.binding,
    });
  }
  const queue = new RuntimeQueue<string>();
  for (let i = 0; i < 257; i++) queue.push("fixture");
  let bounded = false;
  try {
    for await (const _item of queue) {
      /* drain to the bounded failure */
    }
  } catch {
    bounded = true;
  }
  const checks = {
    freshSession: !first.previous,
    resumeSameBinding: samples[0]?.resumed === true,
    changedBindingsRefused: samples.slice(1).every((row) => !row.resumed),
    nativeQueueBound: bounded,
  };
  return {
    id: "O10",
    experiment: "O10",
    tier: "T1",
    status: Object.values(checks).every(Boolean) ? "passed" : "finding",
    checks,
    measurements: { samples, liveNativeProcessCount: null, retainedMemory: null },
    coverage: ["real-PostgreSQL-native-session-binding", "native-queue-overflow-negative-control"],
    gaps: [
      "CLI restart, login revocation, protocol-version changes and leak slope require protocol-process/installed-client acceptance; no live native support claim.",
      "Grants are rechecked separately by O6; the session binding is not an authorization cache.",
    ],
  };
}

export async function computerLifecycleExperiment(): Promise<MatrixResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "matrix-computer-"));
  try {
    const sandbox = new FakeSandboxProvider();
    const context = {
      spaceId: "fixture",
      userId: "fixture",
      operationId: "matrix",
      traceId: "matrix",
      signal: new AbortController().signal,
    };
    const request = { botId: "fixture", homePath: dir };
    const cold = await sandbox.provision(request, context);
    const warm = await sandbox.provision(request, context);
    await sandbox.stop(warm, context);
    const resumed = await sandbox.provision(request, context);
    const other = await sandbox.provision({ ...request, botId: "other-fixture" }, context);
    const checks = {
      coldFresh: cold.fresh === true,
      warmSameComputer: warm.id === cold.id && warm.fresh === false,
      stoppedResume: resumed.id === cold.id,
      scopesDistinct: other.id !== cold.id,
    };
    const desktop = await runComputerLifecycle(
      new DesktopSandboxProvider({ root: dir }),
      request,
      context,
    );
    return {
      id: "O11",
      experiment: "O11",
      tier: "T0",
      status: "incomplete",
      checks: { ...checks, ...desktop.checks },
      measurements: {
        modes: ["fake", "desktop"],
        runners: COMPUTER_RUNNERS,
        desktop: desktop.measurements,
        imageAbsent: "requires-provisioned-container-runner",
        checkpointedWorkspace: "provider-specific; not startup snapshot",
        diskGrowth: null,
        idleCost: null,
      },
      coverage: ["existing-fake-computer-lifecycle", "production-desktop-workspace-file-retention"],
      gaps: [
        "Docker/Podman/Kubernetes/SSH lifecycle, bounded eviction and image-absent behavior require provider-specific isolated runners using runComputerLifecycle; snapshot receipts do not prove restore semantics.",
      ],
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runComponentExperiments(
  databaseUrl: string,
  id: string,
  plan: ReturnType<typeof matrixPlan>,
): Promise<MatrixResult> {
  if (!isOwnedReplayDatabase(databaseUrl)) throw new Error("Unowned matrix database");
  const db = createDb(databaseUrl);
  const restore = denyExternalTcp();
  try {
    if (id === "O2") return await streamingExperiment(db.prisma);
    if (id === "O3") return await prefixExperiment();
    if (id === "O4") return await compactionExperiment(db);
    if (id === "O6") return await connectorExperiment(db, plan.connectors);
    if (id === "O8") return await rateLimitExperiment();
    if (id === "O10") return await nativeBindingExperiment(db);
    if (id === "O11") return await computerLifecycleExperiment();
    return {
      id,
      experiment: id,
      tier: "T0",
      status: "incomplete",
      checks: {},
      measurements: {},
      coverage: [],
      gaps: [
        id === "O13"
          ? "feature-not-implemented: startup snapshot; use normal initialization"
          : "Owned by W0-7/W0-8/W0-9; no local evidence supplied",
      ],
    };
  } finally {
    restore();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}
