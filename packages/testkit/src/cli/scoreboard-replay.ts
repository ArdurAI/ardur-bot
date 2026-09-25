import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTaskContract } from "../scoreboard/graders/contracts.js";
import { OUTCOME_ORACLE_HASH } from "../scoreboard/graders/outcome.js";
import {
  canonicalSerialize,
  contentDigest,
  createScoreboardManifest,
} from "../scoreboard/manifest.js";
import type { TaskTrialEvidence } from "../scoreboard/replay/evidence.js";
import { replayTaskEvidence, taskTrialId } from "../scoreboard/replay/evidence.js";
import { credentialFreeEnvironment, denyExternalTcp } from "../scoreboard/replay/offline.js";
import type { ReplayFixture, ReplayTiming } from "../scoreboard/replay/protocol.js";
import { DEPARTMENT_TASKS, getTask, TASK_PACK_HASH } from "../scoreboard/tasks/catalog.js";
import type { TaskVariant } from "../scoreboard/tasks/variants.js";

const fixtureDirectory = fileURLToPath(new URL("../scoreboard/replay/fixtures/", import.meta.url));
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error("Use explicit --key=value arguments");
    return [match[1]!, match[2]!] as const;
  }),
);
for (const key of args.keys())
  if (
    ![
      "tier",
      "task",
      "timing",
      "tools",
      "history",
      "capacity",
      "output",
      "record",
      "route",
      "budget",
    ].includes(key)
  )
    throw new Error(`Unknown argument: ${key}`);

async function digestDiff() {
  const tracked = execFileSync("git", ["diff", "--binary", "HEAD"], {
    encoding: "utf8",
    // A reviewed refresh of the 30 tapes can exceed the subprocess default of 1 MiB.
    maxBuffer: 32 * 1024 * 1024,
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  return contentDigest({
    tracked,
    untracked: await Promise.all(
      untracked.map(async (name) => ({
        path: name,
        sha256: createHash("sha256")
          .update(await readFile(name))
          .digest("hex"),
      })),
    ),
  });
}

async function main() {
  const tier = args.get("tier") ?? "T0";
  if (!["T0", "T1", "T3"].includes(tier)) throw new Error("Supported tiers: T0, T1, explicit T3");
  if (tier === "T3") {
    if (!args.get("route") || !args.get("budget"))
      throw new Error(
        "T3 requires explicit --route and --budget; no live route is selected by default",
      );
    throw new Error(
      "T3 CLI needs a validated route counter and production runner binding; use runBoundedLive with explicit route, budgets and transport. Live acceptance is incomplete.",
    );
  }
  if (args.has("route") || args.has("budget"))
    throw new Error("Live route parameters are only valid for T3");
  const timing = (args.get("timing") ?? "zero-service-delay") as ReplayTiming;
  if (!["zero-service-delay", "fixed-delay"].includes(timing))
    throw new Error("Unknown timing mode");
  const record = args.get("record") === "true";
  const toolTransport = args.get("tools") ?? "local";
  if (toolTransport !== "local" && toolTransport !== "remote")
    throw new Error("Unknown tool transport");
  if (args.has("record") && args.get("record") !== "true")
    throw new Error("Recording must be explicitly true");
  if (record && tier !== "T1") throw new Error("Record only with T1");
  const tasks = args.get("task") ? args.get("task")!.split(",").map(getTask) : DEPARTMENT_TASKS;
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new Error("Duplicate task selection");
  const history = args.get("history") ?? "short";
  const capacity = Number(args.get("capacity") ?? 16000);
  if (history !== "short" && history !== "long") throw new Error("Unknown history variant");
  if (capacity !== 16000 && capacity !== 128000 && capacity !== 1000000)
    throw new Error("Unknown simulated capacity");
  const variant: TaskVariant = { history, tools: toolTransport, capacity };
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const report: Record<string, unknown> = {
    version: 1,
    tier,
    kind: record
      ? "unvalidated-recording"
      : tier === "T0"
        ? "deterministic-contract"
        : "production-path-replay",
    baseCommit,
    diffDigest: await digestDiff(),
    taskPackHash: TASK_PACK_HASH,
    oracleHash: contentDigest({
      contract: OUTCOME_ORACLE_HASH,
      source: await readFile(new URL("../scoreboard/graders/outcome.ts", import.meta.url), "utf8"),
    }),
    createdAt: new Date().toISOString(),
    timing: tier === "T0" ? "virtual" : timing,
    liveAgentSuccess: null,
    toolTransport,
    variant,
    humanJudgment: "release-calibration-required",
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      postgresImage: tier === "T1" ? "postgres:16-alpine" : null,
      workerConcurrency: tier === "T1" ? 1 : null,
      cacheState:
        tier === "T1"
          ? "fresh-database-and-workspace; dependency-and-os-caches-uncontrolled"
          : "virtual",
      packaged: false,
    },
    traces: "incomplete-W0-4",
    results: [],
  };
  const results = report.results as unknown[];
  const output = args.get("output") ?? `.context/performance/scoreboard/${Date.now()}`;
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "binding.json"), `${canonicalSerialize(report)}\n`, {
    flag: "wx",
  });
  let failed = false;
  if (tier === "T0") {
    for (const task of tasks) {
      const result = validateTaskContract(task);
      results.push(result);
      if (!result.passed) failed = true;
    }
  } else {
    const cleanEnvironment = credentialFreeEnvironment(process.env);
    for (const key of Object.keys(process.env))
      if (!(key in cleanEnvironment)) delete process.env[key];
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET = "synthetic-scoreboard-auth-secret-32";
    process.env.ENCRYPTION_KEY = "scoreboard-synthetic-encryption-key";
    process.env.LOG_LEVEL = "off";
    report.credentialCoverage = "provider-credentials-absent";
    // Heavy product/database modules load only for an explicitly selected production-path run.
    const { provisionReplayPostgres } = await import("../scoreboard/replay/postgres.js");
    const { runProductionTask, FIXTURE_ENCRYPTION_KEY } = await import(
      "../scoreboard/replay/production.js"
    );
    const { DepartmentSandbox, DepartmentServices } = await import(
      "../scoreboard/replay/services.js"
    );
    const { startReplayHttp } = await import("../scoreboard/replay/http.js");
    const { startReferenceRecording } = await import("../scoreboard/replay/recording.js");
    const postgres = await provisionReplayPostgres();
    try {
      const { createApp } = await import("../../../../apps/api/src/app.js");
      const { serve } = await import("@hono/node-server");
      for (const task of tasks) {
        const database = await postgres.fresh();
        process.env.DATABASE_URL = database.url;
        const directory = await mkdtemp(path.join(tmpdir(), "scoreboard-replay-"));
        const originalHome = process.env.HOME;
        process.env.HOME = directory;
        let closeProvider: (() => Promise<void>) | undefined;
        let closeTools: (() => Promise<void>) | undefined;
        let restoreNetwork: (() => void) | undefined;
        try {
          const fixturePath = path.join(
            fixtureDirectory,
            `${task.id}${history === "long" ? "-long" : ""}.json`,
          );
          const recorder = record ? await startReferenceRecording(task, history === "long") : null;
          const fixture = record
            ? null
            : (JSON.parse(await readFile(fixturePath, "utf8")) as ReplayFixture);
          const replayer = fixture ? await startReplayHttp(fixture, timing) : null;
          const provider = recorder ?? replayer!;
          closeProvider = provider.close;
          const services = new DepartmentServices();
          closeTools = await services.transport(toolTransport, timing);
          const sandbox = new DepartmentSandbox(path.join(directory, "computers"), task);
          restoreNetwork = denyExternalTcp();
          const result = await runProductionTask({
            task,
            databaseUrl: database.url,
            dataDir: directory,
            modelBaseUrl: provider.baseUrl,
            services,
            sandbox,
            variant,
            createApp: async () => {
              const handles = await createApp({
                databaseUrl: database.url,
                realtimeDatabaseUrl: database.url,
                dataDir: directory,
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
              if (!address || typeof address === "string")
                throw new Error("API listener unavailable");
              const baseUrl = `http://127.0.0.1:${address.port}`;
              return {
                ...handles,
                app: { request: (input, init) => fetch(`${baseUrl}${input}`, init) },
                stop: async () => {
                  if ("closeAllConnections" in server) server.closeAllConnections();
                  await new Promise<void>((resolve) => server.close(() => resolve()));
                  await handles.stop();
                },
              };
            },
          });
          let replayError: string | null = null;
          try {
            provider.assertComplete();
          } catch (error) {
            replayError = error instanceof Error ? error.message : "Replay validation failed";
          }
          if (recorder && !replayError && result.grade.passed) {
            const recorded = `${JSON.stringify(recorder.fixture(), null, 2)}\n`;
            if (
              [directory, "/Users/", "/var/folders/", "/private/var/"].some((prefix) =>
                recorded.includes(prefix),
              )
            )
              throw new Error("Refused fixture containing a local filesystem path");
            await mkdir(fixtureDirectory, { recursive: true });
            await writeFile(fixturePath, recorded, {
              flag: "wx",
            });
          }
          results.push({
            ...result,
            replayContractPassed: !record && !replayError && result.grade.passed,
            replayError,
            requestMeasurements: replayer?.replay.requests ?? [],
            capacitySimulations: (replayer?.replay.requests ?? []).map((count) => ({
              ...count,
              capacity,
              outputReserve: 4096,
              fits: count.tokens + 4096 <= capacity,
              kind: "synthetic-budget-simulation",
              actualRouteCapacity: null,
            })),
            fixtureHash: replayer?.replay.sha256 ?? null,
          });
          if (!result.grade.passed || replayError) failed = true;
          console.log(
            `${task.id}: ${record ? "recorded" : "replayed"}, outcome ${result.grade.passed ? "pass" : "fail"}`,
          );
        } catch (error) {
          failed = true;
          results.push({
            taskId: task.id,
            status: "incomplete",
            reason:
              error instanceof Error
                ? [error.message, error.cause instanceof Error ? error.cause.message : ""]
                    .filter(Boolean)
                    .join(": ")
                    .replaceAll(directory, "<fixture-workspace>")
                    .slice(0, 500)
                : "unknown failure",
          });
          console.error(`${task.id}: incomplete`);
        } finally {
          try {
            await writeFile(
              path.join(output, `${task.id}.json`),
              `${canonicalSerialize(results.at(-1))}\n`,
              { flag: "wx" },
            );
          } finally {
            if (originalHome === undefined) delete process.env.HOME;
            else process.env.HOME = originalHome;
            restoreNetwork?.();
            await closeProvider?.();
            await closeTools?.();
            await database.close();
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    } finally {
      await postgres.close();
    }
  }
  report.finalDiffDigest = await digestDiff();
  report.sourceUnchangedDuringRun = report.finalDiffDigest === report.diffDigest;
  if (!record && !report.sourceUnchangedDuringRun) failed = true;
  report.passed = !failed && !record;
  await writeFile(path.join(output, "raw.json"), `${canonicalSerialize(report)}\n`, { flag: "wx" });
  const taskTrials: TaskTrialEvidence[] = record
    ? []
    : results.flatMap((entry, index) => {
        const result = entry as {
          taskId: string;
          grade?: TaskTrialEvidence["grade"];
          fixtureHash?: string | null;
          terminal?: string;
          replayContractPassed?: boolean;
        };
        if (!result.grade) return [];
        return [
          {
            taskId: result.taskId,
            trialId: taskTrialId(result.taskId, index),
            sessionId: `session-${index}`,
            traceId: `trace-${index}`,
            pairId: null,
            fixtureHash: result.fixtureHash ?? TASK_PACK_HASH,
            graderHash: String(report.oracleHash),
            outcome:
              result.grade.passed && result.replayContractPassed !== false
                ? ("success" as const)
                : result.terminal === "timed-out"
                  ? ("timed-out" as const)
                  : ("failed" as const),
            grade: {
              ...result.grade,
              passed: result.grade.passed && result.replayContractPassed !== false,
            },
          },
        ];
      });
  await writeFile(
    path.join(output, "task-evidence.json"),
    `${canonicalSerialize(replayTaskEvidence(taskTrials))}\n`,
    { flag: "wx" },
  );
  await writeFile(
    path.join(output, "manifest.json"),
    `${canonicalSerialize(createScoreboardManifest())}\n`,
    { flag: "wx" },
  );
  await writeFile(
    path.join(output, "checksums.json"),
    `${canonicalSerialize(
      await Promise.all(
        (await readdir(output)).sort().map(async (name) => ({
          name,
          sha256: createHash("sha256")
            .update(await readFile(path.join(output, name)))
            .digest("hex"),
        })),
      ),
    )}\n`,
    { flag: "wx" },
  );
  console.log(JSON.stringify({ tier, tasks: results.length, passed: report.passed, output }));
  process.exitCode = failed ? 1 : record ? 2 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Scoreboard failed");
  process.exitCode = 2;
});
