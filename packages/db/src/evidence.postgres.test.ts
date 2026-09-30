import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createEvidenceStore, EvidenceSequenceConflict } from "./evidence.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("append-only evidence (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `evidence-org-${suffix}`;
  const spaceId = `evidence-space-${suffix}`;
  const userId = `evidence-user-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let runId: string;
  let store: ReturnType<typeof createEvidenceStore>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    store = createEvidenceStore(prisma);
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Evidence fixture",
        slug: organizationId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Evidence fixture" } },
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Evidence fixture", color: "ink" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Fixture",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    runId = run.id;
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ardur.evidence_delete = 'on'`;
      await tx.organization.delete({ where: { id: organizationId } });
    });
    await close();
  });

  const record = (seq: number) => ({
    spaceId,
    runId,
    seq,
    receiptId: `${runId}:${seq}`,
    kid: "fixture",
    jws: `fixture-${seq}`,
    sha256: `hash-${seq}`,
    parentSha256: seq ? `hash-${seq - 1}` : null,
    verdict: "compliant",
    decisionKind: "allowed_by_default",
    toolName: "read_file",
  });

  it("inserts and reads in sequence order; returns a typed sequence conflict", async () => {
    await store.insertRecord(record(1));
    await store.insertRecord(record(0));
    expect((await store.recordsForRun(runId)).map((row) => row.seq)).toEqual([0, 1]);
    expect((await store.lastRecord(runId))?.seq).toBe(1);
    await expect(
      store.insertRecord({ ...record(1), receiptId: "other-receipt" }),
    ).rejects.toBeInstanceOf(EvidenceSequenceConflict);
  });
  it("rejects record updates and deletes, even updates with the deletion flag", async () => {
    await expect(
      prisma.evidenceRecord.updateMany({ where: { runId }, data: { jws: "changed" } }),
    ).rejects.toThrow();
    await expect(prisma.evidenceRecord.deleteMany({ where: { runId } })).rejects.toThrow();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ardur.evidence_delete = 'on'`;
        await tx.evidenceRecord.updateMany({ where: { runId }, data: { jws: "changed" } });
      }),
    ).rejects.toThrow();
  });
  it("keeps evidence after the run is deleted", async () => {
    await prisma.run.delete({ where: { id: runId } });
    expect(await store.recordsForRun(runId)).toHaveLength(2);
  });
  it("seals once and rejects seal updates/deletes and new records", async () => {
    const data = {
      spaceId,
      runId,
      jws: "fixture-seal",
      headSha256: "hash-1",
      recordCount: 2,
      gapCount: 0,
    };
    const first = await store.insertSeal(data);
    expect((await store.insertSeal(data)).id).toBe(first.id);
    await expect(
      prisma.evidenceSeal.update({ where: { runId }, data: { jws: "changed" } }),
    ).rejects.toThrow();
    await expect(prisma.evidenceSeal.delete({ where: { runId } })).rejects.toThrow();
    await expect(store.insertRecord(record(2))).rejects.toThrow("sealed");
  });
  it("allows only one active key and one revocation, never key replacement", async () => {
    const key = await store.insertKey({
      spaceId,
      kid: `key-${suffix}`,
      publicKeyPem: "fixture-public",
      privateKeyCiphertext: "fixture-ciphertext",
      secretRecordId: "fixture-record",
    });
    expect(
      (
        await store.insertKey({
          spaceId,
          kid: `other-${suffix}`,
          publicKeyPem: "other",
          privateKeyCiphertext: "other",
          secretRecordId: "other",
        })
      ).id,
    ).toBe(key.id);
    await expect(
      prisma.evidenceKey.update({ where: { id: key.id }, data: { publicKeyPem: "changed" } }),
    ).rejects.toThrow();
    await prisma.evidenceKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    await expect(
      prisma.evidenceKey.update({ where: { id: key.id }, data: { revokedAt: null } }),
    ).rejects.toThrow();
    await expect(prisma.evidenceKey.delete({ where: { id: key.id } })).rejects.toThrow();
  });
  it("allows deletion only in the flagged transaction, including space cascades", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ardur.evidence_delete = 'on'`;
      await tx.evidenceRecord.deleteMany({ where: { runId } });
      await tx.evidenceSeal.deleteMany({ where: { runId } });
    });
    await store.insertRecord(record(0));
    await expect(prisma.space.delete({ where: { id: spaceId } })).rejects.toThrow();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ardur.evidence_delete = 'on'`;
      await tx.space.delete({ where: { id: spaceId } });
    });
    expect(await store.recordsForRun(runId)).toEqual([]);
  });
});
