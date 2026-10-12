import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import { verifyChain, verifySeal } from "@ardurbot/adapters/evidence-format";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { createDb, createEvidenceStore } from "@ardurbot/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evidenceKeyHistory,
  mountEvidenceRoutes,
  replaceSpaceEvidenceKey,
  revokeSpaceEvidenceKey,
  runEvidenceSummary,
} from "./evidence.js";
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
  it("shares a public-only active identity and compares expected fingerprints", async () => {
    const summary = await runEvidenceSummary(prisma, actor(userId), runId);
    const identity = summary.signingIdentity!;
    expect(Object.keys(identity).sort()).toEqual(["fingerprint", "keyVersion", "scope"]);
    expect(identity).toMatchObject({ scope: { type: "space", id: spaceId }, keyVersion: 1 });
    expect(identity.fingerprint).toBe(summary.evidence!.keyId);
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE|Ciphertext|secretRecordId|BEGIN/);
    expect(summary.signerMatch).toBe("no_expected_key");
    expect(
      (await runEvidenceSummary(prisma, actor(userId), runId, identity.fingerprint)).signerMatch,
    ).toBe("expected_key");
    expect(
      (await runEvidenceSummary(prisma, actor(userId), runId, `sha256:${"0".repeat(64)}`))
        .signerMatch,
    ).toBe("different_key");
    const downloaded = await download(actor(userId), runId);
    const files = extractEvidenceArchive(new Uint8Array(await downloaded.arrayBuffer()));
    const records = files
      .get("journal.jsonl")!
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).jwt);
    expect(
      verifySeal(
        files.get("seal.jwt")!.trim(),
        records,
        files.get("evidence-public.pem")!,
        identity.fingerprint,
      ).signerMatch,
    ).toBe("expected_key");
    const substitute = signedRunFixture();
    expect(
      verifySeal(
        substitute.seal.jws,
        substitute.journal,
        substitute.keys.publicKeyPem,
        identity.fingerprint,
      ),
    ).toMatchObject({ ok: true, signerMatch: "different_key" });
  });
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

describePostgres("signing key rotation and revocation (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const orgId = `evidence-keys-${suffix}`;
  const spaceId = `${orgId}-space`;
  const ownerId = `${orgId}-owner`;
  const memberId = `${orgId}-member`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let runId: string;
  let fixtureKeys: ReturnType<typeof signedRunFixture>["keys"];
  const secrets: Pick<EncryptedSecretStore, "put"> = {
    put: async (_plaintext, _context, recordId) => ({
      id: recordId,
      ciphertext: "fixture-ciphertext",
    }),
  };
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
        name: "Evidence keys fixture",
        slug: orgId,
        createdAt: new Date(),
        spaces: { create: { id: spaceId, name: "Evidence keys fixture" } },
      },
    });
    for (const [id, role] of [
      [ownerId, "owner"],
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
    const bot = await prisma.bot.create({
      data: { spaceId, userId: ownerId, name: "Fixture", color: "ink" },
    });
    const thread = await prisma.thread.create({
      data: { spaceId, userId: ownerId, botId: bot.id },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId: ownerId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Fixture",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId: ownerId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "completed",
        trigger: "user",
        completedAt: new Date(),
      },
    });
    runId = run.id;
    const signed = signedRunFixture(run.id, spaceId, bot.id);
    fixtureKeys = signed.keys;
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
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ardur.evidence_delete = 'on'`;
      await tx.organization.delete({ where: { id: orgId } });
      await tx.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    });
    await close();
  });
  const download = (viewer: Actor, id: string) => {
    const app = new Hono();
    mountEvidenceRoutes(app, prisma, async () => viewer);
    return app.request(`/api/evidence/runs/${id}?spaceId=${viewer.spaceId}`);
  };
  async function headKeyId() {
    const history = await evidenceKeyHistory(prisma, actor(ownerId), "session-1");
    return history.keys.at(-1)!.keyId;
  }
  it("lets the owner rotate the key while the admitted run keeps verifying", async () => {
    const history = await evidenceKeyHistory(prisma, actor(ownerId), "session-1");
    expect(history.canManage).toBe(true);
    const active = history.keys.find((entry) => entry.state === "active")!;
    expect(active.keyId).toBe(fixtureKeys.kid);
    const rotated = await replaceSpaceEvidenceKey(
      { prisma, secrets },
      actor(ownerId),
      "session-1",
      active.keyId,
    );
    expect(rotated.keys.map((entry) => entry.state)).toEqual(["replaced", "active"]);
    expect(rotated.keys[1]).toMatchObject({ version: 2 });
    expect(rotated.keys[1]!.keyId).not.toBe(active.keyId);
    expect(JSON.stringify(rotated)).not.toMatch(/PRIVATE|Ciphertext|BEGIN/);
    // The identity card shows the new key; the run still names the key that admitted it.
    const summary = await runEvidenceSummary(prisma, actor(ownerId), runId);
    expect(summary.state).toBe("verified");
    expect(summary.signingIdentity).toMatchObject({ keyVersion: 2 });
    expect(summary.evidence).toMatchObject({ keyId: fixtureKeys.kid, keyRevision: 1 });
    // The old bundle still verifies offline against the retained public key.
    const response = await download(actor(ownerId), runId);
    expect(response.status).toBe(200);
    const files = extractEvidenceArchive(new Uint8Array(await response.arrayBuffer()));
    const journal = files
      .get("journal.jsonl")!
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).jwt);
    expect(verifySeal(files.get("seal.jwt")!.trim(), journal, fixtureKeys.publicKeyPem).ok).toBe(
      true,
    );
  });
  it("maps a raced replacement to a conflict instead of overwriting", async () => {
    const before = await evidenceKeyHistory(prisma, actor(ownerId), "session-1");
    const kid = await headKeyId();
    await replaceSpaceEvidenceKey({ prisma, secrets }, actor(ownerId), "session-1", kid);
    await expect(
      replaceSpaceEvidenceKey({ prisma, secrets }, actor(ownerId), "session-1", kid),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await evidenceKeyHistory(prisma, actor(ownerId), "session-1");
    expect(after.keys).toHaveLength(before.keys.length + 1);
    expect(after.keys.filter((entry) => entry.state === "active")).toHaveLength(1);
  });
  it("refuses members, paired devices and nonmembers from replacing or revoking", async () => {
    const kid = await headKeyId();
    await expect(
      replaceSpaceEvidenceKey({ prisma, secrets }, actor(memberId), "session-1", kid),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      revokeSpaceEvidenceKey(prisma, actor(memberId), "session-1", kid, "lost device"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A paired device acts with the owner's membership but no authenticated session.
    await expect(
      replaceSpaceEvidenceKey({ prisma, secrets }, actor(ownerId), undefined, kid),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      revokeSpaceEvidenceKey(prisma, actor(ownerId), undefined, kid, "lost device"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      replaceSpaceEvidenceKey({ prisma, secrets }, actor("outsider"), "session-1", kid),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await evidenceKeyHistory(prisma, actor(memberId))).canManage).toBe(false);
    await expect(evidenceKeyHistory(prisma, actor("outsider"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("dates an emergency revocation and keeps earlier records verified", async () => {
    const kid = await headKeyId();
    // Signatures in the revocation's own second are untrusted, so revoke in a
    // later second than the run's records to check that earlier ones verify.
    await new Promise((resolve) => setTimeout(resolve, 1050 - (Date.now() % 1000)));
    const revoked = await revokeSpaceEvidenceKey(
      prisma,
      actor(ownerId),
      "session-1",
      kid,
      "compromised fixture",
    );
    expect(revoked.keys.at(-1)).toMatchObject({
      state: "revoked",
      revokedReason: "compromised fixture",
      revokedAt: expect.any(String),
    });
    const summary = await runEvidenceSummary(prisma, actor(ownerId), runId);
    expect(summary.state).toBe("verified");
    expect(summary.evidence?.revocationListRevision).toBeTruthy();
    // Offline check with the dated revocation: records before it verify.
    const response = await download(actor(ownerId), runId);
    const files = extractEvidenceArchive(new Uint8Array(await response.arrayBuffer()));
    const journal = files
      .get("journal.jsonl")!
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).jwt);
    expect(
      verifySeal(files.get("seal.jwt")!.trim(), journal, fixtureKeys.publicKeyPem, undefined, {
        revokedAt: new Date(summary.evidence!.revocationListRevision!),
      }).ok,
    ).toBe(true);
    // Signing stays stopped until the owner authorizes a replacement.
    await expect(
      replaceSpaceEvidenceKey({ prisma, secrets }, actor(ownerId), "session-1", kid),
    ).resolves.toMatchObject({
      keys: expect.arrayContaining([
        expect.objectContaining({ state: "active", version: expect.any(Number) }),
      ]),
    });
  });
});
