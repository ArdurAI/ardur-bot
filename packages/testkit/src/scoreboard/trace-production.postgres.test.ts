import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPool } from "@ardurbot/db";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp as CreateApp } from "../../../../apps/api/src/app.js";
import { startScoreboardTrace } from "../../../adapters/src/scoreboard-trace.js";
import { canonicalSerialize, contentDigest } from "./manifest.js";
import { startReplayHttp } from "./replay/http.js";
import { denyExternalTcp } from "./replay/offline.js";
import { FIXTURE_ENCRYPTION_KEY, runProductionTask } from "./replay/production.js";
import type { ReplayFixture } from "./replay/protocol.js";
import { DepartmentSandbox, DepartmentServices } from "./replay/services.js";
import { getTask } from "./tasks/catalog.js";
import { collectTraceEvidence, LOCAL_TRACE_BOUNDARIES } from "./trace-collector.js";

const databaseUrl = process.env.SCOREBOARD_TEST_DATABASE_URL;
const pairedSamples = Number(process.env.TRACE_PAIRED_SAMPLES ?? 0);
if (!Number.isSafeInteger(pairedSamples) || pairedSamples < 0 || pairedSamples > 50)
  throw new Error("Invalid trace sample plan");
const trials = pairedSamples
  ? Array.from({ length: pairedSamples }, (_, pair) =>
      (pair % 2 ? [true, false] : [false, true]).map((enabled) => ({ pair, enabled })),
    ).flat()
  : [{ pair: 0, enabled: true }];
describe.skipIf(!databaseUrl)("production trace on disposable PostgreSQL", () => {
  let createApp: typeof CreateApp;
  let admin: ReturnType<typeof createPool> | undefined;
  beforeAll(async () => {
    ({ createApp } = await import("../../../../apps/api/src/app.js"));
    if (pairedSamples) {
      const url = new URL(databaseUrl!);
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.pathname !== "/scoreboard_trial_1"
      )
        throw new Error("Trace trials require a disposable template database");
      url.pathname = "/postgres";
      admin = createPool(url.toString());
    }
  });
  afterAll(async () => {
    await admin?.end();
  });
  it.each(trials)(
    "production boundaries, pair $pair, collector $enabled",
    async ({ pair, enabled }) => {
      let trialUrl = databaseUrl!;
      const name = `scoreboard_trial_${pair * 2 + (enabled ? 2 : 3)}`;
      if (admin) {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "scoreboard_trial_1"`);
        const url = new URL(databaseUrl!);
        url.pathname = `/${name}`;
        trialUrl = url.toString();
      }
      const task = getTask("task-01");
      const directory = await mkdtemp(path.join(tmpdir(), "trace-fixture-"));
      const fixture = JSON.parse(
        await readFile(new URL("./replay/fixtures/task-01.json", import.meta.url), "utf8"),
      ) as ReplayFixture;
      const provider = await startReplayHttp(fixture, "zero-service-delay");
      const services = new DepartmentServices();
      await services.transport("local", "zero-service-delay");
      const sandbox = new DepartmentSandbox(path.join(directory, "computers"), task);
      const trace = enabled ? startScoreboardTrace() : undefined;
      const restore = denyExternalTcp();
      try {
        const result = await runProductionTask({
          task,
          databaseUrl: trialUrl,
          dataDir: directory,
          modelBaseUrl: provider.baseUrl,
          services,
          sandbox,
          createApp: async () => {
            const handles = await createApp({
              databaseUrl: trialUrl,
              realtimeDatabaseUrl: trialUrl,
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
            if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
            return {
              ...handles,
              app: {
                request: (input, init) => fetch(`http://127.0.0.1:${address.port}${input}`, init),
              },
              stop: async () => {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
                await handles.stop();
              },
            };
          },
        });
        const evidence =
          enabled && trace
            ? collectTraceEvidence([trace.snapshot()], {
                sessionId: `session-${pair}`,
                pairId: `pair-${pair}`,
                requiredBoundaries: LOCAL_TRACE_BOUNDARIES,
                expectedTraces: 1,
              })
            : null;
        if (process.env.TRACE_REPORT_DIR) {
          await mkdir(process.env.TRACE_REPORT_DIR, { recursive: true });
          const report = {
            version: 1,
            tier: "T1",
            scenario: "trace-collector-on-off",
            pair,
            enabled,
            taskId: task.id,
            fixtureHash: provider.replay.sha256,
            elapsedMs: result.elapsedMs,
            terminal: result.terminal,
            grade: result.grade,
            usage: result.usage,
            evidence,
          };
          await writeFile(
            path.join(process.env.TRACE_REPORT_DIR, `${contentDigest(report)}.json`),
            canonicalSerialize(report),
            { flag: "wx" },
          );
        }
        provider.assertComplete();
        expect(result.grade.passed).toBe(true);
        if (!evidence) return;
        expect(evidence.derived).toHaveLength(1);
        expect(evidence.derived[0]!.missingBoundaries).toEqual([]);
        expect(evidence.derived[0]!.complete).toBe(true);
        expect(evidence.derived[0]!.operations.every((o) => o.duration.value !== null)).toBe(true);
        expect(
          evidence.metrics.find((m) => m.id === "m01.user-ttft")!.observations[0]!.value,
        ).toBeNull();
      } finally {
        trace?.stop();
        restore();
        await provider.close();
        await rm(directory, { recursive: true, force: true });
        if (admin) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    },
    90_000,
  );
});
