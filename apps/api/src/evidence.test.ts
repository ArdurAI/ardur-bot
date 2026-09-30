import { verifyChain, verifySeal } from "@ardurbot/adapters/evidence-format";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountEvidenceRoutes, runEvidenceSummary } from "./evidence.js";
import { extractEvidenceArchive, signedRunFixture } from "./evidence-test-fixture.js";

const actor: Actor = {
  userId: "viewer",
  spaceId: "space",
  email: "viewer@example.test",
  isDeploymentOwner: false,
};
function fixture(role: string | null = "owner") {
  const signed = signedRunFixture();
  const run = {
    id: "run",
    spaceId: "space",
    botId: "bot",
    threadId: "thread",
    thread: { groupId: null },
    status: "completed",
    createdAt: new Date(),
    startedAt: null,
    evidenceGapCount: 0,
  };
  const records = vi.fn(async () => signed.records);
  const seal = vi.fn(async () => signed.seal as typeof signed.seal | null);
  const prisma = {
    spaceMember: { findUnique: vi.fn(async () => (role ? { role } : null)) },
    run: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === run.id && where.spaceId === run.spaceId ? run : null,
      ),
    },
    bot: {
      findFirst: vi.fn(async ({ where }) =>
        where.userId === actor.userId
          ? { id: "bot", thread: { id: "thread" }, computer: null }
          : null,
      ),
    },
    evidenceRecord: { findMany: records },
    evidenceSeal: { findUnique: seal },
    evidenceKey: {
      findUnique: vi.fn(async () => ({ spaceId: "space", publicKeyPem: signed.keys.publicKeyPem })),
    },
  } as unknown as PrismaClient;
  const app = new Hono();
  mountEvidenceRoutes(app, prisma, async () => actor);
  return {
    signed,
    run,
    records,
    seal,
    prisma,
    download: () => app.request("/api/evidence/runs/run?spaceId=space"),
  };
}

describe("run evidence", () => {
  it.each(["owner", "member"])(
    "allows a %s who can see the run to summarize and download",
    async (role) => {
      const f = fixture(role);
      const summary = await runEvidenceSummary(f.prisma, actor, "run");
      expect(summary).toMatchObject({
        sessionId: "run",
        state: "verified",
        sealed: true,
        captureLevel: "decisions",
        decisions: { allowed: 1, denied: 1, asked: 1, recorded: 3 },
        gates: { spend: null, risks: [] },
        evidence: { encrypted: false, keyId: f.signed.keys.kid },
      });
      const response = await f.download();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="ardur-evidence-run.tar.gz"',
      );
      const files = extractEvidenceArchive(new Uint8Array(await response.arrayBuffer()));
      expect([...files.keys()]).toEqual([
        "journal.jsonl",
        "seal.jwt",
        "evidence-public.pem",
        "README.md",
      ]);
      const journal = files
        .get("journal.jsonl")!
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).jwt);
      expect(verifyChain(journal, files.get("evidence-public.pem")!).ok).toBe(true);
      expect(
        verifySeal(files.get("seal.jwt")!.trim(), journal, files.get("evidence-public.pem")!).ok,
      ).toBe(true);
    },
  );
  it("returns 404 to nonmembers before reading evidence", async () => {
    const f = fixture(null);
    await expect(runEvidenceSummary(f.prisma, actor, "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await f.download()).status).toBe(404);
    expect(f.records).not.toHaveBeenCalled();
  });
  it("returns 404 for another space's run", async () => {
    const f = fixture();
    f.run.spaceId = "other";
    await expect(runEvidenceSummary(f.prisma, actor, "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await f.download()).status).toBe(404);
    expect(f.records).not.toHaveBeenCalled();
  });
  it("does not grant thread access merely for being a space member", async () => {
    const f = fixture("member");
    vi.mocked(f.prisma.bot.findFirst).mockResolvedValue(null);
    await expect(runEvidenceSummary(f.prisma, actor, "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await f.download()).status).toBe(404);
    expect(f.records).not.toHaveBeenCalled();
  });
  it("keeps a run without evidence invisible regardless of current feature state", async () => {
    const f = fixture();
    f.records.mockResolvedValue([]);
    f.seal.mockResolvedValue(null);
    expect((await runEvidenceSummary(f.prisma, actor, "run")).state).toBe("off");
    expect(await (await f.download()).json()).toEqual({
      error: "Evidence is not available for download.",
      state: "off",
    });
  });
  it.each(["running", "completed", "failed", "cancelled"])(
    "reports %s with records but no seal honestly",
    async (status) => {
      const f = fixture();
      f.run.status = status;
      f.seal.mockResolvedValue(null);
      const expected = status === "running" ? "recording" : "unsealed";
      expect((await runEvidenceSummary(f.prisma, actor, "run")).state).toBe(expected);
      const response = await f.download();
      expect(response.status).toBe(409);
      expect((await response.json()).state).toBe(expected);
    },
  );
  it("reports verified gaps with their count and permits the sealed download", async () => {
    const f = fixture();
    f.run.evidenceGapCount = 2;
    expect(await runEvidenceSummary(f.prisma, actor, "run")).toMatchObject({
      state: "gap",
      gapCount: 2,
      sealed: true,
    });
    expect((await f.download()).status).toBe(200);
  });
  it("only returns failure codes for corrupt evidence, never record contents", async () => {
    const f = fixture();
    f.signed.records[0]!.jws = "private-corrupted-content";
    const summary = await runEvidenceSummary(f.prisma, actor, "run");
    expect(summary).toMatchObject({ state: "failed", sealed: false });
    expect(summary.failureCodes).toContain("malformed_jws");
    expect(JSON.stringify(summary)).not.toContain("private-corrupted-content");
    expect((await f.download()).status).toBe(409);
  });
  it("rejects a correctly signed chain transplanted from a different run", async () => {
    const f = fixture();
    const other = signedRunFixture("other-run");
    f.records.mockResolvedValue(other.records);
    f.seal.mockResolvedValue(other.seal);
    vi.mocked(f.prisma.evidenceKey.findUnique).mockResolvedValue({
      spaceId: "space",
      publicKeyPem: other.keys.publicKeyPem,
    } as never);
    expect(await runEvidenceSummary(f.prisma, actor, "run")).toMatchObject({
      state: "failed",
      failureCodes: ["run_mismatch"],
    });
  });
});
