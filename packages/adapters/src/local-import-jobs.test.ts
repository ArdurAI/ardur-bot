import { dispatchBackgroundJob } from "@ardurbot/adapter-kit";
import type { HostRequest } from "@ardurbot/contracts/host-bridge";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import type { PrismaClient } from "@ardurbot/db";
import { hostLostProblem } from "@ardurbot/host-runtime/bridge-wire";
import { createLogger, createTestSink, installLogger, runCorrelatedJob } from "@ardurbot/logging";
import type { MemoryService } from "@ardurbot/memory";
import { localImportFixture } from "@ardurbot/testkit/local-import-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalImportJobs } from "./local-import-jobs.js";

vi.mock("@ardurbot/host-runtime/host-client", () => ({
  HostClient: class {
    // biome-ignore lint/correctness/useYield: the fixture host is always disconnected.
    async *request() {
      throw new RuntimePinError(
        hostLostProblem({ operation: { op: "import.scan" } } as unknown as HostRequest),
      );
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  installLogger(createLogger({ service: "ardurbot-worker", level: "off", sinks: [] }));
});
const job = {
  requestId: "00000000-0000-4000-8000-00000000aaaa",
  spaceId: "space",
  userId: "owner",
  action: { action: "undo", tool: "claude-code" },
} as const;
function jobs(options: { packaged?: boolean; reply?: (...args: unknown[]) => void } = {}) {
  const prisma = {
    deploymentSettings: { findUnique: async () => ({ ownerUserId: job.userId }) },
    spaceMember: { findUnique: async () => ({ role: "owner" }) },
    localImportConfig: {
      upsert: async () => ({ id: "config", roots: {}, manifest: localImportFixture }),
    },
    localImportRecord: { findMany: async () => [] },
  };
  return createLocalImportJobs(prisma as unknown as PrismaClient, {} as MemoryService, {
    apiUrl: "http://api:3100",
    encryptionKey: "fixture-encryption-material",
    packaged: options.packaged ?? false,
    ...(options.reply ? { reply: options.reply } : {}),
  });
}
/** Runs the handler the way the worker does, so the job outcome is logged. */
async function runJob(handlers: ReturnType<typeof jobs>, payload: unknown) {
  const sink = createTestSink();
  installLogger(createLogger({ service: "ardurbot-worker", sinks: [sink] }));
  const outcome = await runCorrelatedJob({
    name: "local-import.run",
    payload,
    run: () =>
      dispatchBackgroundJob(
        handlers as Parameters<typeof dispatchBackgroundJob>[0],
        "local-import.run",
        payload,
      ),
  }).then(
    () => "resolved",
    (error: Error) => error.name,
  );
  return { outcome, events: sink.events };
}
it("posts the real import result to the configured API service callback", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await jobs()["local-import.run"]!(job);
  const [url, init] = fetch.mock.calls[0]! as unknown as [URL, RequestInit];
  expect(url.href).toBe("http://api:3100/api/local-import/result");
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("authorization")).toMatch(/^Bearer /);
  expect(JSON.parse(String(init.body))).toEqual({
    requestId: job.requestId,
    response: {
      result: {
        created: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
      },
    },
  });
});
it("answers a stale scan with its reason, logs the error and fails the job", async () => {
  const reply = vi.fn();
  const { outcome, events } = await runJob(jobs({ reply }), {
    ...job,
    action: {
      action: "import",
      scanId: "00000000-0000-4000-8000-00000000ffff",
      categories: ["skills"],
    },
  });
  expect(reply).toHaveBeenCalledWith(job.requestId, { stopped: "rescan" });
  expect(outcome).toBe("LocalImportRescanError");
  expect(events.at(-1)).toMatchObject({
    message: "job.completed",
    "job.outcome": "error",
    error: { name: "LocalImportRescanError", message: expect.stringContaining("Re-scan") },
  });
});
it("reports a lost host as a host failure, distinct from other failures", async () => {
  const reply = vi.fn();
  const { outcome, events } = await runJob(jobs({ packaged: true, reply }), {
    ...job,
    action: { action: "scan" },
  });
  expect(reply).toHaveBeenCalledWith(job.requestId, { stopped: "host" });
  expect(outcome).toBe("LocalImportHostError");
  expect(events.at(-1)).toMatchObject({
    "job.outcome": "error",
    error: { name: "LocalImportHostError", cause: { name: "RuntimePinError" } },
  });
});
it("gives an actionable worker error when the API callback cannot be reached", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
  await expect(jobs()["local-import.run"]!(job)).rejects.toThrow(
    "The import result could not reach the API. Check API_INTERNAL_URL.",
  );
});
it("rejects an unsuccessful API callback", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  await expect(jobs()["local-import.run"]!(job)).rejects.toThrow(
    "The import result could not be delivered.",
  );
});
