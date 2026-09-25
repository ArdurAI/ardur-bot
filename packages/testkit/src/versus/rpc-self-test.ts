import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelEmulatorStep } from "../model-emulator.js";
import { startModelEmulator } from "../model-emulator.js";
import { gradeOutcome } from "../scoreboard/graders/outcome.js";
import { contentDigest } from "../scoreboard/manifest.js";
import { startReplayHttp } from "../scoreboard/replay/http.js";
import type { ProductionApp } from "../scoreboard/replay/production.js";
import type { ReplayFixture } from "../scoreboard/replay/protocol.js";
import { startReferenceRecording } from "../scoreboard/replay/recording.js";
import { getTask } from "../scoreboard/tasks/catalog.js";
import { referenceSolution } from "../scoreboard/tasks/reference.js";
import type { VersusEvent } from "./adapters/types.js";
import { startBroker, TrialBroker } from "./broker.js";
import { BudgetLedger, parseBudget, requireValue } from "./budget.js";
import { startGateway } from "./gateway.js";
import { createTrialDirectory, destroyOwnedDirectory, prepareEnvironment } from "./isolation.js";
import { inspectBuild, repositoryRoot, sanitize } from "./provenance.js";
import { selfTestBudget } from "./self-test.js";

/** Opt-in real application integration. Parent never imports the application or loads dotenv. */
export async function rpcSelfTest(output: string) {
  const build = await inspectBuild();
  const resource = await createTrialDirectory(tmpdir());
  const out = path.resolve(output);
  await mkdir(out, { recursive: true });
  const reportFile = path.join(out, "rpc-self-test.json");
  await writeFile(
    reportFile,
    JSON.stringify({
      status: "started",
      tier: "T0",
      realModelCalls: 0,
      ownedContainerLabel: resource.owner,
    }),
    { flag: "wx" },
  );
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // Reuse an already-running local engine and image. Never pull or start an owner's service.
    const endpoint = execFileSync(
      "docker",
      ["context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}'],
      { encoding: "utf8" },
    ).trim();
    requireValue(endpoint.startsWith("unix://"), "A local Docker engine is required");
    const image = execFileSync(
      "docker",
      ["image", "inspect", "postgres:16-alpine", "--format", "{{.Id}}"],
      { encoding: "utf8" },
    ).trim();
    requireValue(
      /^sha256:[a-f0-9]{64}$/.test(image),
      "Cached PostgreSQL image required; no download authorized",
    );
    const env = await prepareEnvironment(resource.state, process.execPath);
    const pnpmDirectory = path.dirname(
      execFileSync("/usr/bin/which", ["pnpm"], { encoding: "utf8" }).trim(),
    );
    env.PATH = `${pnpmDirectory}${path.delimiter}${env.PATH}`;
    Object.assign(env, {
      DOCKER_HOST: endpoint,
      TESTCONTAINERS_RYUK_DISABLED: "true",
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: "synthetic-scoreboard-auth-secret-32",
      ENCRYPTION_KEY: "scoreboard-synthetic-encryption-key",
      LOG_LEVEL: "error",
    });
    child = spawn(
      process.execPath,
      ["--import", "tsx", new URL(import.meta.url).pathname, "--child", resource.root, reportFile],
      { cwd: repositoryRoot, env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let diagnostics = "";
    const append = (chunk: Buffer) => {
      diagnostics = (
        diagnostics + sanitize(chunk.toString("utf8"), [resource.root, repositoryRoot])
      ).slice(-24000);
    };
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    // Seven fresh database/app lifecycles have their own bounded trial deadlines.
    const timer = setTimeout(() => child?.kill("SIGTERM"), 600000);
    const killTimer = setTimeout(() => child?.kill("SIGKILL"), 605000);
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
    }
    await writeFile(path.join(out, "rpc-diagnostics.txt"), diagnostics, { flag: "wx" });
    const result = JSON.parse(await readFile(reportFile, "utf8"));
    const sourceUnchangedDuringRun =
      contentDigest(build.build) === contentDigest((await inspectBuild()).build);
    await writeFile(
      reportFile,
      `${JSON.stringify({ ...result, build: build.build, sourceUnchangedDuringRun, postgresImage: image, childExitCode: code }, null, 2)}\n`,
    );
    requireValue(
      code === 0 && result.passed === true && sourceUnchangedDuringRun,
      "Real-stack self-test failed; retained RPC report and diagnostics",
    );
    return result;
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const remaining = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `label=ardur.versus.owner=${resource.owner}`],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const id of remaining) {
      requireValue(/^[a-f0-9]{12,64}$/.test(id), "Invalid owned container identity");
      execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
    }
    await destroyOwnedDirectory(resource);
  }
}

async function childMain(root: string, reportFile: string) {
  const results: Record<string, unknown>[] = [];
  const report = {
    version: 1,
    kind: "real-application-scripted-provider",
    tier: "T0",
    timing: "virtual-contract-results",
    realModelCalls: 0,
    reasoningQuality: null,
    productPerformance: null,
    results,
    sourceDrift: [] as Record<string, unknown>[],
    phase: "provisioning-owned-database",
    passed: false,
  };
  const save = () =>
    writeFile(reportFile, `${sanitize(JSON.stringify(report, null, 2), [root, repositoryRoot])}\n`);
  await save();
  const prismaConfig = path.join(root, "prisma.config.ts");
  await writeFile(
    prismaConfig,
    `export default { schema: ${JSON.stringify(path.join(repositoryRoot, "packages/db/prisma/schema.prisma"))}, migrations: { path: ${JSON.stringify(path.join(repositoryRoot, "packages/db/prisma/migrations"))} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    { flag: "wx" },
  );
  const { provisionReplayPostgres } = await import("../scoreboard/replay/postgres.js");
  const { denyExternalTcp } = await import("../scoreboard/replay/offline.js");
  const { DepartmentServices, DepartmentSandbox } = await import(
    "../scoreboard/replay/services.js"
  );
  const { FIXTURE_ENCRYPTION_KEY, fixtureRpc } = await import("../scoreboard/replay/production.js");
  const { ArdurAdapter } = await import("./adapters/ardur.js");
  const ownerToken = await readFile(path.join(root, ".versus-owner"), "utf8");
  const postgres = await provisionReplayPostgres({ prismaConfig, ownerToken });
  await save();
  try {
    // The application is an optional runtime composition root outside the package's rootDir.
    const applicationModule = new URL("../../../../apps/api/src/app.js", import.meta.url).href;
    const { createApp } = (await import(applicationModule)) as {
      createApp(
        options: Record<string, unknown>,
      ): Promise<
        ProductionApp & { app: { fetch(request: Request): Promise<Response> | Response } }
      >;
    };
    const { serve } = await import("@hono/node-server");
    let recordedFixture: ReplayFixture | null = null;
    for (const scenario of [
      "landed-fixture-drift-check",
      "ordinary-recording",
      "ordinary-strict-replay",
      "mcp-connection",
      "approval-denied",
      "approval-resume",
      "cancel-held-provider",
    ] as const) {
      report.phase = scenario;
      await save();
      const database = await postgres.fresh();
      const directory = await createTrialDirectory(root);
      const task = getTask(scenario.startsWith("approval") ? "task-04" : "task-01");
      const events: VersusEvent[] = [];
      const observedRequests: unknown[] = [];
      const emit = (
        kind: VersusEvent["kind"],
        source: VersusEvent["source"],
        data: Record<string, unknown>,
      ) =>
        events.push({
          kind,
          source,
          data,
          trialId: scenario,
          sequence: events.length,
          at: events.length,
          clock: "virtual" as const,
        });
      let adapter: InstanceType<typeof ArdurAdapter> | undefined;
      let provider:
        | { baseUrl: string; close: () => Promise<void>; assertComplete: () => void }
        | undefined;
      let recorder: Awaited<ReturnType<typeof startReferenceRecording>> | undefined;
      let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
      let mcp: Awaited<ReturnType<typeof startBroker>> | undefined;
      let broker: TrialBroker | undefined;
      let restoreNetwork: (() => void) | undefined;
      try {
        process.env.DATABASE_URL = database.url;
        const budget = parseBudget({
          ...selfTestBudget(),
          model: { ...selfTestBudget().model, id: "scoreboard-v1" },
          contextSize: 262144,
          maxOutputTokens: 4096,
          perTrial: {
            requests: 12,
            logicalInput: 4000000,
            output: 100000,
            totalTokens: 4100000,
            wallMs: 120000,
            toolCalls: 100,
            descendants: 4,
          },
        });
        if (scenario === "ordinary-recording") {
          recorder = await startReferenceRecording(task);
          provider = recorder;
        } else if (
          scenario === "ordinary-strict-replay" ||
          scenario === "landed-fixture-drift-check"
        ) {
          const fixture =
            scenario === "ordinary-strict-replay"
              ? recordedFixture
              : (JSON.parse(
                  await readFile(
                    new URL("../scoreboard/replay/fixtures/task-01.json", import.meta.url),
                    "utf8",
                  ),
                ) as ReplayFixture);
          requireValue(
            fixture,
            "Current-source recording unavailable; strict replay cannot be substituted",
          );
          // The tape stays immutable on disk. The gateway's preregistered route parameters are explicit.
          for (const exchange of fixture.exchanges) {
            const body = (exchange.request as { body: Record<string, unknown> }).body;
            delete body.max_completion_tokens;
            Object.assign(body, {
              max_tokens: budget.maxOutputTokens,
              temperature: budget.temperature,
              seed: budget.seed,
              n: 1,
            });
          }
          provider = await startReplayHttp(fixture);
        } else {
          const expectedTools = (request: Parameters<ModelEmulatorStep["expect"]>[0]) => {
            assert.equal(request.model, "scoreboard-v1");
            assert.equal(request.stream, true);
            assert.ok(
              JSON.stringify(request.messages).includes(JSON.stringify(task.prompt).slice(1, -1)),
              "Synthetic task is present in the assembled request",
            );
          };
          const steps: ModelEmulatorStep[] =
            scenario === "mcp-connection"
              ? [
                  {
                    expect: expectedTools,
                    response: (request) => {
                      const tool = request.tools?.find(
                        (tool) =>
                          tool.function.name !== "SCOREBOARD_READ" &&
                          tool.function.name.endsWith("SCOREBOARD_READ"),
                      );
                      requireValue(
                        tool,
                        "Assigned MCP broker tool missing from production catalog",
                      );
                      return {
                        type: "tool",
                        id: "synthetic-mcp-read",
                        name: tool.function.name,
                        arguments: {},
                      };
                    },
                  },
                  {
                    expect: (request) =>
                      assert.ok(request.messages.some((message) => message.role === "tool")),
                    response: { type: "text", text: "Synthetic MCP protocol completed." },
                  },
                ]
              : scenario === "cancel-held-provider"
                ? [
                    {
                      expect: expectedTools,
                      response: {
                        type: "hold",
                        onOpen: () => {
                          void adapter!.cancel();
                        },
                      },
                    },
                  ]
                : [
                    {
                      expect: expectedTools,
                      response: {
                        type: "tool",
                        id: "synthetic-update",
                        name: "SCOREBOARD_UPDATE",
                        arguments: { ...referenceSolution(task).updates[0]! },
                      },
                    },
                    {
                      expect: (request) => {
                        const resumed = JSON.stringify(request.messages);
                        assert.ok(resumed.includes("Review before SCOREBOARD_UPDATE"));
                        assert.equal(
                          resumed.includes("resuming after the user approved"),
                          scenario === "approval-resume",
                        );
                      },
                      response:
                        scenario === "approval-resume"
                          ? {
                              type: "tool",
                              id: "synthetic-approved-update",
                              name: "SCOREBOARD_UPDATE",
                              arguments: { ...referenceSolution(task).updates[0]! },
                            }
                          : { type: "text", text: "Synthetic denial observed." },
                    },
                    ...(scenario === "approval-resume"
                      ? [
                          {
                            expect: (request: Parameters<ModelEmulatorStep["expect"]>[0]) =>
                              assert.ok(
                                request.messages.some((message) => message.role === "tool"),
                              ),
                            response: {
                              type: "text" as const,
                              text: "Synthetic approval protocol completed.",
                            },
                          },
                        ]
                      : []),
                  ];
          provider = await startModelEmulator({ modelId: "scoreboard-v1", steps });
        }
        budget.endpoint.origin = new URL(provider.baseUrl).origin;
        const ledger = new BudgetLedger(budget);
        ledger.open(scenario);
        if (scenario === "mcp-connection") {
          broker = new TrialBroker({
            trialId: scenario,
            task,
            workspace: directory.workspace,
            journal: path.join(root, `${scenario}-receipts.jsonl`),
            ledger,
            emit,
          });
          await broker.prepare();
          mcp = await startBroker(broker);
        }
        gateway = await startGateway({
          budget,
          ledger,
          evidenceKind: "virtual",
          credential: () => "local",
          transport: (url, init) => {
            observedRequests.push(JSON.parse(String(init.body)));
            return fetch(url, init);
          },
        });
        const providerUrl = gateway.capability(scenario, null, emit);
        const services = new DepartmentServices();
        const sandbox = new DepartmentSandbox(path.join(directory.root, "computers"), task);
        let decisions = 0;
        adapter = new ArdurAdapter({
          databaseUrl: database.url,
          dataDir: directory.state,
          services,
          sandbox,
          mode: "scripted-provider",
          preapproveConsent: false,
          connectBroker: scenario === "mcp-connection",
          observe: async (handles, observation) => {
            if (observation.terminal === "timed-out") {
              const errors = await handles.prisma.$queryRaw<
                { last_error: string | null }[]
              >`SELECT last_error FROM graphile_worker.jobs WHERE task_identifier = 'run.continue' AND last_error IS NOT NULL`;
              emit("diagnostic", "application-database", {
                workerErrors: errors.map((item) =>
                  sanitize(item.last_error ?? "", [root, repositoryRoot]),
                ),
              });
            }
          },
          configure: async (handles, cookie, botId) => {
            if (scenario.startsWith("approval"))
              await fixtureRpc(handles, cookie, "approvalRules/set", {
                effect: "require_approval",
                matchKind: "tool",
                matchValue: "SCOREBOARD_UPDATE",
                botId,
              });
          },
          waiting: async (handles, _cookie, _botId, runId) => {
            requireValue(scenario.startsWith("approval"), "Unexpected product input request");
            const messages = await handles.prisma.message.findMany({
              where: { runId, role: "bot" },
              select: { id: true, blocks: true },
              orderBy: { seq: "desc" },
            });
            const message = messages.find(
              (item) =>
                Array.isArray(item.blocks) &&
                item.blocks.some(
                  (block) =>
                    block &&
                    typeof block === "object" &&
                    "kind" in block &&
                    block.kind === "ask" &&
                    "approvalEffectId" in block,
                ),
            );
            requireValue(message && decisions === 0, "Approval identity missing or repeated");
            decisions++;
            await adapter!.answer(message.id, scenario === "approval-denied" ? "deny" : "allow");
          },
          createApp: async () => {
            const handles = await createApp({
              databaseUrl: database.url,
              realtimeDatabaseUrl: database.url,
              dataDir: directory.state,
              authUrl: "http://127.0.0.1:5173",
              webOrigin: "http://127.0.0.1:5173",
              authSecret: "synthetic-scoreboard-auth-secret-32",
              encryptionKey: FIXTURE_ENCRYPTION_KEY,
              sandbox,
              sandboxProvider: "fake",
              agentRuntime: "pi",
              wakeupDriver: "graphile",
              composio: services,
              signupsEnabled: "true",
              signupAllowlist: "",
              cloudAgentProvider: "emulator",
              piSessionRecording: false,
            });
            const server = serve({ fetch: handles.app.fetch, hostname: "127.0.0.1", port: 0 });
            await new Promise<void>((resolve) =>
              server.listening ? resolve() : server.once("listening", resolve),
            );
            const address = server.address();
            requireValue(address && typeof address !== "string", "Disposable API listener missing");
            const origin = `http://127.0.0.1:${address.port}`;
            return {
              ...handles,
              app: { request: (input, init) => fetch(`${origin}${input}`, init) },
              stop: async () => {
                if ("closeAllConnections" in server) server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
                await handles.stop();
              },
            };
          },
        });
        restoreNetwork = denyExternalTcp();
        let revoked = false;
        await adapter.prepare({
          id: scenario,
          pairId: `rpc-${scenario}`,
          task,
          workspace: directory.workspace,
          stateDirectory: directory.state,
          budget,
          providerUrl,
          revokeProvider: () => {
            if (revoked) return;
            revoked = true;
            gateway!.revoke(scenario);
            emit("diagnostic", "provider-gateway", {
              boundary: "controller-revoked-trial-capability",
              productPrevention: false,
              remoteBillingStopped: null,
            });
          },
          brokerUrl: mcp?.url ?? "unused-native-fixture",
          emit,
          signal: new AbortController().signal,
        });
        await adapter.submit();
        const collected = await adapter.collect();
        provider.assertComplete();
        if (recorder) recordedFixture = recorder.fixture();
        assert.equal(
          events.filter(
            (event) => event.kind === "admission" && event.source === "application-database",
          ).length,
          1,
        );
        assert.ok(
          events.some(
            (event) => event.kind === "terminal" && event.source === "application-database",
          ),
        );
        assert.equal(ledger.snapshot().inFlight, 0);
        if (
          scenario === "ordinary-strict-replay" ||
          scenario === "ordinary-recording" ||
          scenario === "landed-fixture-drift-check"
        )
          assert.equal(gradeOutcome(task, collected.observation).passed, true);
        if (scenario === "mcp-connection") assert.deepEqual(broker!.tools, ["SCOREBOARD_READ"]);
        if (scenario === "approval-denied") {
          assert.equal(decisions, 1);
          assert.equal(collected.observation.effects.length, 0);
        }
        if (scenario === "approval-resume") {
          assert.equal(decisions, 1);
          assert.equal(collected.observation.effects.length, 1);
          assert.equal(collected.observation.terminal, "completed");
        }
        if (scenario === "cancel-held-provider") {
          assert.equal(collected.observation.terminal, "cancelled");
          assert.equal(gateway.requests.length, 1);
          assert.equal(gateway.requests[0]!.authoritative, false);
          assert.equal(ledger.snapshot().reservations[0]!.uncertain, true);
          assert.equal(ledger.snapshot().trials[0]!.closed, true);
        }
        results.push({
          scenario,
          passed: true,
          terminal: collected.observation.terminal,
          observationHash: contentDigest(collected.observation),
          reply: collected.observation.reply,
          fixtureHash: recordedFixture ? contentDigest(recordedFixture) : null,
          decisions,
          effects: collected.observation.effects,
          events,
          observedRequests,
          requests: gateway.requests,
          budget: ledger.snapshot(),
          recovery:
            scenario === "approval-resume"
              ? "persisted checkpoint resumed by production answer RPC and worker; no forced process crash"
              : null,
        });
      } catch (error) {
        const failure = {
          scenario,
          passed: false,
          reason: sanitize(
            error instanceof Error
              ? `${error.message}\n${error.stack ?? ""}\n${error instanceof AggregateError ? error.errors.map((item) => (item instanceof Error ? item.message : String(item))).join("\n") : ""}`
              : String(error),
            [root, repositoryRoot],
          ),
          events,
          observedRequests,
        };
        if (scenario === "landed-fixture-drift-check")
          report.sourceDrift.push({
            ...failure,
            handling:
              "retained infrastructure incompatibility; fails offline qualification; unchanged landed tape",
          });
        else results.push(failure);
      } finally {
        restoreNetwork?.();
        await adapter?.destroy();
        await gateway?.close();
        await mcp?.close();
        await provider?.close();
        await database.close();
        await destroyOwnedDirectory(directory);
        await save();
      }
    }
    report.passed =
      results.length === 7 &&
      report.sourceDrift.length === 0 &&
      results.every((result) => result.passed);
    report.phase = "finished";
  } finally {
    await postgres.close();
    await save();
  }
  requireValue(report.passed, "One or more offline production RPC scenarios failed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const action =
    args[0] === "--child" && args.length === 3
      ? childMain(args[1]!, args[2]!)
      : args[0] === "--out" && args.length === 2
        ? rpcSelfTest(args[1]!)
        : Promise.reject(
            new Error("Use --out <new-directory>; requires a cached local PostgreSQL image"),
          );
  action.catch((error) => {
    console.error(sanitize(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
