import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyChain, verifySeal } from "@ardurbot/adapters/evidence-format";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { createDb, createEvidenceStore } from "@ardurbot/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountEvidenceRoutes, runEvidenceSummary } from "./evidence.js";
import { extractEvidenceArchive, signedRunFixture } from "./evidence-test-fixture.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
describePostgres("run evidence download (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const orgId = `evidence-download-${suffix}`;
  const spaceId = `${orgId}-space`;
  const userId = `${orgId}-user`;
  const memberId = `${orgId}-member`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let runId: string;
  let memberRunId: string;
  const actor = (id: string): Actor => ({
    userId: id,
    spaceId,
    email: "fixture@example.test",
    isDeploymentOwner: false,
  });
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: orgId,
        name: "Evidence fixture",
        slug: orgId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Evidence fixture" } },
      },
    });
    for (const [id, role] of [
      [userId, "owner"],
      [memberId, "member"],
    ] as const) {
      await prisma.user.create({ data: { id, name: "Fixture", email: `${id}@example.test` } });
      await prisma.member.create({
        data: {
          id: `${id}-organization-membership`,
          organizationId: orgId,
          userId: id,
          role,
          createdAt: new Date(),
        },
      });
      await prisma.spaceMember.create({
        data: {
          id: `${id}-membership`,
          organizationId: orgId,
          spaceId,
          userId: id,
          role,
          createdAt: new Date(),
        },
      });
    }
    const store = createEvidenceStore(prisma);
    const keys = signedRunFixture().keys;
    for (const id of [userId, memberId]) {
      const bot = await prisma.bot.create({
        data: { spaceId, userId: id, name: "Fixture", color: "ink" },
      });
      const thread = await prisma.thread.create({ data: { spaceId, userId: id, botId: bot.id } });
      const task = await prisma.task.create({
        data: {
          spaceId,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Fixture",
          status: "completed",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId,
          userId: id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: "user",
          completedAt: new Date(),
        },
      });
      if (id === userId) runId = run.id;
      else memberRunId = run.id;
      const signed = signedRunFixture(run.id, spaceId, bot.id, keys);
      await store.insertKey({
        spaceId,
        kid: signed.keys.kid,
        publicKeyPem: signed.keys.publicKeyPem,
        privateKeyCiphertext: "unused-fixture-ciphertext",
        secretRecordId: "fixture",
      });
      for (const row of signed.records)
        await store.insertRecord({
          spaceId,
          runId: run.id,
          seq: row.seq,
          receiptId: row.receiptId,
          kid: row.kid,
          jws: row.jws,
          sha256: row.sha256,
          parentSha256: row.parentSha256,
          verdict: row.verdict,
          decisionKind: row.decisionKind,
          toolName: row.toolName,
        });
      await store.insertSeal(signed.seal);
    }
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ardur.evidence_delete = 'on'`;
      await tx.organization.delete({ where: { id: orgId } });
      await tx.user.deleteMany({ where: { id: { in: [userId, memberId] } } });
    });
    await close();
  });
  const download = (viewer: Actor, id: string) => {
    const app = new Hono();
    mountEvidenceRoutes(app, prisma, async () => viewer);
    return app.request(`/api/evidence/runs/${id}?spaceId=${viewer.spaceId}`);
  };
  it("downloads exactly the four independently verifiable bundle files", async () => {
    expect((await runEvidenceSummary(prisma, actor(userId), runId)).state).toBe("verified");
    const response = await download(actor(userId), runId);
    expect(response.status).toBe(200);
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
    const publicKey = files.get("evidence-public.pem")!;
    expect(verifyChain(journal, publicKey).ok).toBe(true);
    expect(verifySeal(files.get("seal.jwt")!.trim(), journal, publicKey).ok).toBe(true);
    if (process.env.ARDUR_EVIDENCE_SAMPLE_DIR) {
      await mkdir(process.env.ARDUR_EVIDENCE_SAMPLE_DIR, { recursive: true });
      for (const [name, contents] of files)
        await writeFile(path.join(process.env.ARDUR_EVIDENCE_SAMPLE_DIR, name), contents);
    }
  });
  it("allows a member's visible run but not another member's private thread", async () => {
    expect((await runEvidenceSummary(prisma, actor(memberId), memberRunId)).state).toBe("verified");
    expect((await download(actor(memberId), memberRunId)).status).toBe(200);
    await expect(runEvidenceSummary(prisma, actor(memberId), runId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await download(actor(memberId), runId)).status).toBe(404);
  });
  it("returns 404 for nonmembers and a run requested from another space", async () => {
    for (const viewer of [actor("outsider"), { ...actor(userId), spaceId: "other-space" }]) {
      await expect(runEvidenceSummary(prisma, viewer, runId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect((await download(viewer, runId)).status).toBe(404);
    }
  });
});
