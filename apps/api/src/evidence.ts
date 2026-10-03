import { Readable } from "node:stream";
import type { HomeArchiveFile } from "@ardurbot/adapter-kit";
import { buildEvidenceBundle, verifyChain, verifySeal } from "@ardurbot/adapters/evidence-format";
import type { Actor } from "@ardurbot/contracts";
import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import { evidenceState } from "@ardurbot/contracts/evidence-states";
import type { PrismaClient } from "@ardurbot/db";
import { createEvidenceStore, IsolationError } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { Context, Hono } from "hono";
import { gzipArchive } from "./export-archive.js";
import { resolveThreadTarget } from "./thread-target.js";

async function loadRunEvidence(prisma: PrismaClient, actor: Actor, runId: string) {
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
  const store = createEvidenceStore(prisma);
  const [records, seal] = await Promise.all([store.recordsForRun(runId), store.sealForRun(runId)]);
  const kid = records[0]?.kid ?? "";
  const key = kid ? await store.keyByKid(kid) : null;
  const journal = records.map((row) => row.jws);
  const failures = new Set<string>();
  if (records.length || seal) {
    const chain = verifyChain(journal, key?.publicKeyPem ?? "");
    for (const failure of chain.failures) failures.add(failure.code);
    if (seal) {
      for (const failure of verifySeal(seal.jws, journal, key?.publicKeyPem ?? "").failures)
        failures.add(failure.code);
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
          keyRevision: 1,
          revocationListRevision: "",
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

export async function runEvidenceSummary(prisma: PrismaClient, actor: Actor, runId: string) {
  return (await loadRunEvidence(prisma, actor, runId)).summary;
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
