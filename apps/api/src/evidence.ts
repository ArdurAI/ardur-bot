import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { HomeArchiveFile } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import {
  buildEvidenceBundle,
  evidenceKeyId,
  generateEvidenceKey,
  verifyChain,
  verifySeal,
} from "@ardurbot/adapters/evidence-format";
import type { Actor } from "@ardurbot/contracts";
import type {
  EvidenceKeyHistory,
  EvidenceKeyHistoryEntry,
  EvidenceRecordView,
  EvidenceRunSummary,
} from "@ardurbot/contracts/evidence";
import { EvidenceRevocationReasonSchema } from "@ardurbot/contracts/evidence";
import { evidenceState } from "@ardurbot/contracts/evidence-states";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import {
  createEvidenceStore,
  EvidenceKeyConflict,
  IsolationError,
  replaceEvidenceKey,
  revokeEvidenceKey,
} from "@ardurbot/db";
import { redactCommandOutput, redactCredentialText } from "@ardurbot/logging";
import { ORPCError } from "@orpc/server";
import type { Context, Hono } from "hono";
import { gzipArchive } from "./export-archive.js";
import { resolveThreadTarget } from "./thread-target.js";

/**
 * The one access rule for a run's evidence: space membership, a run in this
 * space, and a thread the actor can resolve. Both evidence readers share it,
 * so a record can never be easier to reach than the run it belongs to.
 */
type EvidenceRunRow = Prisma.RunGetPayload<{ include: { thread: { select: { groupId: true } } } }>;

async function assertRunEvidenceAccess(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
): Promise<EvidenceRunRow> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  if (!member) throw new ORPCError("NOT_FOUND");
  const run = await prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId },
    include: { thread: { select: { groupId: true } } },
  });
  if (!run) throw new ORPCError("NOT_FOUND");
  try {
    const target = await resolveThreadTarget(prisma, actor, {
      ...(run.thread.groupId ? { groupId: run.thread.groupId } : { botId: run.botId }),
      threadId: run.threadId,
    });
    if (target.threadId !== run.threadId) throw new ORPCError("NOT_FOUND");
  } catch (error) {
    if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
    throw error;
  }
  return run;
}

async function loadRunEvidence(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  expectedFingerprint?: string,
) {
  const run = await assertRunEvidenceAccess(prisma, actor, runId);
  const store = createEvidenceStore(prisma);
  const [records, seal] = await Promise.all([store.recordsForRun(runId), store.sealForRun(runId)]);
  const kid = records[0]?.kid ?? "";
  const key = kid
    ? await prisma.evidenceKey.findUnique({
        where: { kid },
        select: {
          publicKeyPem: true,
          spaceId: true,
          version: true,
          replacedAt: true,
          revokedAt: true,
        },
      })
    : null;
  const activeKey = await prisma.evidenceKey.findFirst({
    where: { spaceId: actor.spaceId, revokedAt: null },
    select: { publicKeyPem: true, spaceId: true, version: true },
  });
  const journal = records.map((row) => row.jws);
  const failures = new Set<string>();
  let signerMatch: EvidenceRunSummary["signerMatch"] = null;
  if (records.length || seal) {
    // Only an emergency revocation untrusts later signatures; a replaced key
    // stays valid for runs admitted before the rotation, like the recorder.
    const options = key?.revokedAt && !key.replacedAt ? { revokedAt: key.revokedAt } : undefined;
    const chain = verifyChain(journal, key?.publicKeyPem ?? "", undefined, options);
    for (const failure of chain.failures) failures.add(failure.code);
    if (seal) {
      const verified = verifySeal(
        seal.jws,
        journal,
        key?.publicKeyPem ?? "",
        expectedFingerprint,
        options,
      );
      signerMatch = verified.signerMatch;
      for (const failure of verified.failures) failures.add(failure.code);
    }
    if (
      key?.spaceId !== actor.spaceId ||
      records.some(
        (row, index) => row.spaceId !== actor.spaceId || row.seq !== index || row.kid !== kid,
      ) ||
      (seal && seal.spaceId !== actor.spaceId)
    )
      failures.add("run_mismatch");
    if (chain.ok) {
      for (const [index, jws] of journal.entries()) {
        const claims = JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString());
        if (claims.step_id !== `${runId}:${index}` || claims.actor !== `bot:${run.botId}`)
          failures.add("run_mismatch");
      }
    }
  }
  const gapCount = Math.max(run.evidenceGapCount, seal?.gapCount ?? 0);
  const state = evidenceState({
    recordCount: records.length,
    finished: ["completed", "failed", "cancelled"].includes(run.status),
    sealed: Boolean(seal),
    verificationFailed: failures.size > 0,
    gapCount,
  });
  const summary: EvidenceRunSummary = {
    signingIdentity: activeKey
      ? {
          fingerprint: evidenceKeyId(activeKey.publicKeyPem),
          scope: { type: "space", id: activeKey.spaceId },
          keyVersion: activeKey.version,
        }
      : null,
    signerMatch: state === "verified" || state === "gap" ? signerMatch : null,
    sessionId: runId,
    recordedAt: (records[0]?.createdAt ?? run.startedAt ?? run.createdAt).toISOString(),
    decisions: {
      allowed: records.filter((row) => row.verdict === "compliant").length,
      denied: records.filter((row) => row.verdict === "violation").length,
      asked: records.filter((row) => row.decisionKind === "asked").length,
      recorded: records.length,
    },
    captureLevel: "decisions",
    evidence: kid
      ? {
          bundleId: runId,
          encrypted: false,
          keyId: kid,
          keyRevision: key?.version ?? 1,
          // Only an emergency revocation is a revocation; a replaced key's
          // retired-at stamp must not read as one to offline verifiers.
          revocationListRevision:
            key?.revokedAt && !key.replacedAt ? key.revokedAt.toISOString() : "",
          verifierUrl: "https://ardur.ai/docs/governance/",
        }
      : null,
    gates: { spend: null, risks: [] },
    state,
    sealed: state === "verified" || state === "gap",
    gapCount,
    failureCodes: [...failures],
  };
  return { summary, journal, seal, key };
}

export async function runEvidenceSummary(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  expectedFingerprint?: string,
) {
  return (await loadRunEvidence(prisma, actor, runId, expectedFingerprint)).summary;
}

/** One tool-result record by id, for a goal condition's support link. */
export async function runEvidenceRecord(
  prisma: PrismaClient,
  actor: Actor,
  recordId: string,
): Promise<EvidenceRecordView> {
  const record = await prisma.evidenceRecord.findFirst({
    where: { id: recordId, spaceId: actor.spaceId },
  });
  if (!record) throw new ORPCError("NOT_FOUND");
  await assertRunEvidenceAccess(prisma, actor, record.runId);
  return {
    id: record.id,
    runId: record.runId,
    receiptId: record.receiptId,
    kid: record.kid,
    toolName: record.toolName,
    verdict: record.verdict,
    decisionKind: record.decisionKind,
    sha256: record.sha256,
    createdAt: record.createdAt.toISOString(),
  };
}

type EvidenceKeyRow = {
  kid: string;
  publicKeyPem: string;
  version: number;
  createdAt: Date;
  replacedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
};

/**
 * An owner may paste a credential into the reason by mistake. Refuse multiline
 * or oversized input before redaction; over-masking accepted text is intentional.
 */
function sanitizeRevocationReason(reason: string): string {
  if (!EvidenceRevocationReasonSchema.safeParse(reason).success) throw new ORPCError("BAD_REQUEST");
  return redactCommandOutput(redactCredentialText(reason)).slice(0, 200);
}

function keyHistoryEntry(row: EvidenceKeyRow, includeReason: boolean): EvidenceKeyHistoryEntry {
  return {
    keyId: row.kid,
    fingerprint: evidenceKeyId(row.publicKeyPem),
    version: row.version,
    state: !row.revokedAt ? "active" : row.replacedAt ? "replaced" : "revoked",
    createdAt: row.createdAt.toISOString(),
    replacedAt: row.replacedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    // The free-text reason can name credentials: only the owner may read it.
    revokedReason: includeReason ? row.revokedReason : null,
  };
}

async function membership(prisma: PrismaClient, actor: Actor) {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  if (!member) throw new ORPCError("NOT_FOUND");
  return member;
}

async function keyHistoryFor(
  prisma: PrismaClient,
  actor: Actor,
  canManage: boolean,
): Promise<EvidenceKeyHistory> {
  const rows = await prisma.evidenceKey.findMany({
    where: { spaceId: actor.spaceId },
    orderBy: { version: "asc" },
  });
  return { canManage, keys: rows.map((row) => keyHistoryEntry(row, canManage)) };
}

/** Public-only key history; any member can compare fingerprints. */
export async function evidenceKeyHistory(
  prisma: PrismaClient,
  actor: Actor,
  authSessionId?: string,
) {
  const member = await membership(prisma, actor);
  // Managing and reading the free-text reason both require an authenticated
  // owner session; paired devices hold the owner's membership but no session.
  const canManage = member.role === "owner" && Boolean(authSessionId);
  return keyHistoryFor(prisma, actor, canManage);
}

/**
 * Replace (or, after an emergency revocation, install) the space's signing key.
 * Owner-only: paired devices have no authenticated user session, and members
 * are not owners. The compare-and-swap pins the key the owner saw.
 */
export async function replaceSpaceEvidenceKey(
  deps: { prisma: PrismaClient; secrets: Pick<EncryptedSecretStore, "put"> },
  actor: Actor,
  authSessionId: string | undefined,
  expectedFingerprint: string,
) {
  const member = await membership(deps.prisma, actor);
  if (member.role !== "owner" || !authSessionId) throw new ORPCError("FORBIDDEN");
  const generated = generateEvidenceKey();
  const secretRecordId = randomUUID();
  const stored = await deps.secrets.put(
    generated.privateKeyPem,
    {
      operationId: `evidence-key:${actor.spaceId}`,
      traceId: `trace:${actor.spaceId}:evidence-key`,
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
    secretRecordId,
  );
  try {
    await replaceEvidenceKey(deps.prisma, {
      spaceId: actor.spaceId,
      expectedKid: expectedFingerprint,
      data: {
        kid: generated.kid,
        publicKeyPem: generated.publicKeyPem,
        privateKeyCiphertext: stored.ciphertext,
        secretRecordId: stored.id,
      },
    });
  } catch (error) {
    if (error instanceof EvidenceKeyConflict)
      throw new ORPCError("CONFLICT", { message: error.message });
    throw error;
  }
  return keyHistoryFor(deps.prisma, actor, true);
}

/** Emergency revocation: signing with the key stops at once. Owner-only. */
export async function revokeSpaceEvidenceKey(
  prisma: PrismaClient,
  actor: Actor,
  authSessionId: string | undefined,
  expectedFingerprint: string,
  reason: string,
) {
  const member = await membership(prisma, actor);
  if (member.role !== "owner" || !authSessionId) throw new ORPCError("FORBIDDEN");
  try {
    await revokeEvidenceKey(prisma, {
      spaceId: actor.spaceId,
      expectedKid: expectedFingerprint,
      reason: sanitizeRevocationReason(reason),
    });
  } catch (error) {
    if (error instanceof EvidenceKeyConflict)
      throw new ORPCError("CONFLICT", { message: error.message });
    throw error;
  }
  return keyHistoryFor(prisma, actor, true);
}

export async function runEvidenceArchive(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  signal?: AbortSignal,
) {
  const { summary, journal, seal, key } = await loadRunEvidence(prisma, actor, runId);
  if (!summary.sealed || !seal || !key)
    throw new ORPCError("CONFLICT", {
      message: "Evidence is not available for download.",
      data: { state: summary.state },
    });
  const files = buildEvidenceBundle({
    runId,
    records: journal,
    seal: seal.jws,
    publicKeyPem: key.publicKeyPem,
  });
  async function* entries(): AsyncGenerator<HomeArchiveFile> {
    for (const file of files) {
      const bytes = Buffer.from(file.contents);
      yield {
        path: file.path,
        size: bytes.length,
        content: (async function* () {
          yield bytes;
        })(),
      };
    }
  }
  return gzipArchive(entries(), signal);
}

export function mountEvidenceRoutes(
  app: Hono,
  prisma: PrismaClient,
  authenticate: (c: Context) => Promise<Actor | null>,
) {
  app.get("/api/evidence/runs/:runId", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Not found" }, 404);
    const runId = c.req.param("runId");
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runId)) return c.json({ error: "Not found" }, 404);
    try {
      const stream = await runEvidenceArchive(prisma, actor, runId, c.req.raw.signal);
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="ardur-evidence-${runId}.tar.gz"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      if (error instanceof ORPCError && error.code === "NOT_FOUND")
        return c.json({ error: "Not found" }, 404);
      if (error instanceof ORPCError && error.code === "CONFLICT")
        return c.json({ error: error.message, ...error.data }, 409);
      throw error;
    }
  });
}
