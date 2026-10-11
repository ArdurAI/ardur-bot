import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { createEvidenceStore, EvidenceKeyConflict, EvidenceSequenceConflict } from "./evidence.js";

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
  const keyData = (kid: string) => ({
    kid,
    publicKeyPem: `fixture-public-${kid}`,
    privateKeyCiphertext: "fixture-ciphertext",
    secretRecordId: "fixture-record",
  });
  it("converges concurrent first-key inserts to one active winner", async () => {
    const key = await store.insertKey({ spaceId, ...keyData(`key-${suffix}`) });
    expect(key.version).toBe(1);
    expect(
      (
        await store.insertKey({
          spaceId,
          ...keyData(`other-${suffix}`),
        })
      ).id,
    ).toBe(key.id);
  });
  it("replaces the head key atomically against the expected key id", async () => {
    const first = (await store.activeKey(spaceId))!;
    await expect(
      store.replaceKey({ spaceId, expectedKid: "sha256:stale", data: keyData("stale") }),
    ).rejects.toBeInstanceOf(EvidenceKeyConflict);
    const second = await store.replaceKey({
      spaceId,
      expectedKid: first.kid,
      data: keyData(`next-${suffix}`),
    });
    expect(second.version).toBe(2);
    const history = await store.keysForSpace(spaceId);
    expect(history.map((row) => row.version)).toEqual([1, 2]);
    expect(history[0]).toMatchObject({ kid: first.kid, revokedAt: expect.any(Date) });
    expect(history[0]!.replacedAt).toBeTruthy();
    expect(history[1]).toMatchObject({ kid: second.kid, replacedAt: null, revokedAt: null });
    // Old public keys are retained for historical verification.
    expect(history[0]!.publicKeyPem).toBe(first.publicKeyPem);
  });
  it("lets only one of two concurrent replacements win", async () => {
    const second = (await store.activeKey(spaceId))!;
    const [won, lost] = await Promise.allSettled([
      store.replaceKey({ spaceId, expectedKid: second.kid, data: keyData(`race-a-${suffix}`) }),
      store.replaceKey({ spaceId, expectedKid: second.kid, data: keyData(`race-b-${suffix}`) }),
    ]);
    const settled = [won, lost];
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    if (lost.status === "rejected") expect(lost.reason).toBeInstanceOf(EvidenceKeyConflict);
    else if (won.status === "rejected") expect(won.reason).toBeInstanceOf(EvidenceKeyConflict);
    const history = await store.keysForSpace(spaceId);
    expect(history).toHaveLength(3);
    expect(history.filter((row) => !row.revokedAt)).toHaveLength(1);
    expect(history.find((row) => !row.revokedAt)?.version).toBe(3);
  });
  it("dates an emergency revocation with its reason and keeps the row", async () => {
    const active = (await store.activeKey(spaceId))!;
    const revoked = await store.revokeKey({
      spaceId,
      expectedKid: active.kid,
      reason: "compromised fixture",
    });
    expect(revoked.revokedAt).toBeTruthy();
    expect(revoked.revokedReason).toBe("compromised fixture");
    expect(revoked.replacedAt).toBeNull();
    expect(await store.activeKey(spaceId)).toBeNull();
    // The retained row still serves historical verification by kid.
    expect((await store.keyByKid(active.kid))?.publicKeyPem).toBe(active.publicKeyPem);
    await expect(
      store.revokeKey({ spaceId, expectedKid: active.kid, reason: "again" }),
    ).rejects.toBeInstanceOf(EvidenceKeyConflict);
    // Replacement after a bare revocation installs the next version.
    const next = await store.replaceKey({
      spaceId,
      expectedKid: active.kid,
      data: keyData(`after-revoke-${suffix}`),
    });
    expect(next.version).toBe(active.version + 1);
  });
  it("rejects key field edits, un-revoke and delete even with the deletion flag", async () => {
    const rows = await store.keysForSpace(spaceId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      await expect(
        prisma.evidenceKey.update({ where: { id: row.id }, data: { publicKeyPem: "changed" } }),
      ).rejects.toThrow();
      await expect(prisma.evidenceKey.delete({ where: { id: row.id } })).rejects.toThrow();
      if (row.revokedAt) {
        await expect(
          prisma.evidenceKey.update({ where: { id: row.id }, data: { revokedAt: null } }),
        ).rejects.toThrow();
        await expect(
          prisma.evidenceKey.update({ where: { id: row.id }, data: { revokedReason: "changed" } }),
        ).rejects.toThrow();
      }
    }
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
