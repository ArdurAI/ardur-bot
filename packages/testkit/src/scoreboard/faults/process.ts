import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@ardurbot/db";
import type { CrashId, MatrixResult } from "../experiments/catalog.js";
import { assertDisposableUrl } from "../experiments/durable.js";
import { CRASH_BOUNDARIES } from "../manifest.js";
import { credentialFreeEnvironment } from "../replay/offline.js";
import { isOwnedReplayDatabase } from "../replay/postgres.js";
import type { NativeHostReady } from "./native-host.js";
import { observeNativeDisconnect } from "./native-host.js";

export interface FaultChildResult {
  type: "boundary" | "result";
  checks: Record<string, boolean>;
  measurements: Record<string, unknown>;
}

export async function faultChild(input: {
  databaseUrl: string;
  directory: string;
  id: CrashId;
  phase: "interrupt" | "recover";
  negative?: "revoke" | "pin";
}) {
  assertDisposableUrl(input.databaseUrl);
  return new Promise<{ message: FaultChildResult; killed: boolean }>((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./worker.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...credentialFreeEnvironment(process.env),
        NODE_ENV: "test",
        LOG_LEVEL: "off",
        // createRepos reads this independently of createApp's sandbox composition option.
        SANDBOX_PROVIDER: "desktop",
        DATABASE_URL: input.databaseUrl,
        BETTER_AUTH_SECRET: "synthetic-matrix-auth-secret-32",
        ENCRYPTION_KEY: "synthetic-matrix-key",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let message: FaultChildResult | undefined;
    let killed = false;
    let diagnostic = "";
    let nativeObservation: ReturnType<typeof observeNativeDisconnect> | undefined;
    let stage = "module-startup";
    const timeout = () => {
      child.kill("SIGKILL");
      reject(new Error(`Fault child deadline: ${input.id}/${input.phase}/${stage}`));
    };
    // Source-mode dependency loading is separate from the bounded experiment deadline.
    let timer = setTimeout(timeout, 300000);
    child.stderr?.on("data", (chunk) => {
      diagnostic = (diagnostic + String(chunk)).slice(-2000);
    });
    child.on(
      "message",
      (
        value:
          | FaultChildResult
          | { type: "error"; code: string }
          | { type: "ready" }
          | { type: "prepared" }
          | { type: "progress"; stage: string }
          | NativeHostReady,
      ) => {
        if (value.type === "progress") {
          process.stdout.write(`${input.id}/${input.phase}: ${value.stage}\n`);
          stage = value.stage;
          return;
        }
        if (value.type === "ready") {
          clearTimeout(timer);
          timer = setTimeout(timeout, 300000);
          child.send(input);
          return;
        }
        if (value.type === "prepared") {
          clearTimeout(timer);
          stage = "durable-experiment";
          timer = setTimeout(timeout, input.phase === "recover" ? 90000 : 60000);
          return;
        }
        if (value.type === "host-ready") {
          nativeObservation = observeNativeDisconnect(value);
          return;
        }
        if (value.type === "error") {
          child.kill("SIGKILL");
          reject(new Error(`Fault child failed: ${value.code}`));
          return;
        }
        message = value;
        if (value.type === "boundary") {
          killed = child.kill("SIGKILL");
        }
      },
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(timer);
      if (!message || (killed ? signal !== "SIGKILL" : code !== 0)) {
        // Only synthetic child diagnostics; omit environment, stack paths and database URI.
        reject(
          new Error(
            `Fault child exited without evidence (${code ?? signal}); ${
              diagnostic
                .split("\n")
                .find((line) => line.startsWith("Error:"))
                ?.replace(/postgres\S+/g, "<database>") ?? "child startup or execution failed"
            }`,
          ),
        );
      } else {
        if (nativeObservation) Object.assign(message.checks, await nativeObservation);
        resolve({ message, killed });
      }
    });
  });
}

export async function runCrashCase(
  databaseUrl: string,
  id: CrashId,
  negative?: "revoke" | "pin",
): Promise<MatrixResult> {
  if (!isOwnedReplayDatabase(databaseUrl))
    throw new Error("Database was not provisioned by this matrix process");
  const boundary = CRASH_BOUNDARIES.find((item) => item.id === id);
  if (!boundary) throw new Error("Unknown crash boundary");
  const directory = await mkdtemp(path.join(tmpdir(), "matrix-fault-"));
  const db = createDb(databaseUrl);
  try {
    const before = await faultChild({ databaseUrl, directory, id, phase: "interrupt" });
    // Advance only the dead process's lease clock; this is not a measured production TTL.
    await db.prisma.run.updateMany({
      where: { status: { in: ["leased", "running"] } },
      data: { leaseExpiresAt: new Date(0) },
    });
    await db.prisma.computerExecutionLease.deleteMany();
    const queue = await db.pool.query<{ table: string | null }>(
      "SELECT to_regclass('graphile_worker._private_jobs')::text AS table",
    );
    let expiredQueueLocks = 0;
    if (queue.rows[0]?.table) {
      // The production worker's stale-lock reclamation still performs the unlock.
      // Only this dead child's disposable database is aged; no owner queue is touched.
      const expired = await db.pool.query(
        "UPDATE graphile_worker._private_jobs SET locked_at = now() - interval '5 hours' WHERE locked_by IS NOT NULL",
      );
      await db.pool.query(
        "UPDATE graphile_worker._private_job_queues SET locked_at = now() - interval '5 hours' WHERE locked_by IS NOT NULL",
      );
      expiredQueueLocks = expired.rowCount ?? 0;
    }
    if (negative === "revoke")
      await db.prisma.actionApprovalRule.updateMany({ data: { effect: "require_approval" } });
    if (negative === "pin")
      await db.prisma.bot.updateMany({
        data: {
          modelProvider: "invalid-fixture",
          modelId: "not-the-run-pin",
          modelPinRevision: { increment: 1 },
        },
      });
    const started = performance.now();
    const after = await faultChild({ databaseUrl, directory, id, phase: "recover", negative });
    const checks = {
      killedAtBoundary: before.killed,
      ...before.message.checks,
      ...after.message.checks,
    };
    return {
      id: `${id}${negative ? `-${negative}` : ""}`,
      experiment: "O9",
      tier: "T1",
      status: Object.values(checks).every(Boolean) ? "passed" : "finding",
      checks,
      measurements: {
        expected: boundary.expected,
        before: before.message.measurements,
        after: after.message.measurements,
        recoveryMs: performance.now() - started,
        leaseClockAdvanced: true,
        expiredQueueLocks,
      },
      coverage: [
        "real-postgresql",
        "real-graphile",
        "SIGKILL",
        "fresh-process-recovery",
        "durable-state-oracle",
      ],
      gaps: [
        "Run/computer and Graphile stale-lock expiry accelerated after confirmed process death; not autonomous wall-clock recovery latency.",
        "Synthetic runtime/tool boundaries; full production provider replay is measured separately.",
        "No native CLI or UI paint acceptance.",
      ],
    };
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}
