import type { PrismaClient } from "@ardurbot/db";
import type { MemoryService } from "@ardurbot/memory";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalImportJobs } from "./local-import-jobs.js";

afterEach(() => vi.unstubAllGlobals());
const job = {
  requestId: "request",
  spaceId: "space",
  userId: "owner",
  action: { action: "undo", tool: "claude-code" },
} as const;
function jobs() {
  const prisma = {
    deploymentSettings: { findUnique: async () => ({ ownerUserId: job.userId }) },
    spaceMember: { findUnique: async () => ({ role: "owner" }) },
    localImportConfig: { upsert: async () => ({ id: "config" }) },
    localImportRecord: { findMany: async () => [] },
  };
  return createLocalImportJobs(prisma as unknown as PrismaClient, {} as MemoryService, {
    apiUrl: "http://api:3100",
    encryptionKey: "fixture-encryption-material",
    packaged: false,
  });
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
    failed: false,
    response: {
      result: { created: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, conflicts: 0 },
    },
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
