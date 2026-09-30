import type { Prisma, PrismaClient } from "./client.js";

export class EvidenceSequenceConflict extends Error {
  constructor(readonly runId: string) {
    super("Evidence sequence already exists");
    this.name = "EvidenceSequenceConflict";
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function lockRun(tx: Prisma.TransactionClient, runId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evidence:${runId}`}, 0))`;
}

export async function insertRecord(
  prisma: PrismaClient,
  data: Prisma.EvidenceRecordUncheckedCreateInput,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockRun(tx, data.runId);
      if (await tx.evidenceSeal.findUnique({ where: { runId: data.runId } })) {
        throw new Error("Evidence run is sealed");
      }
      return tx.evidenceRecord.create({ data });
    });
  } catch (error) {
    if (isUniqueConflict(error)) {
      const exists = await prisma.evidenceRecord.findUnique({
        where: { runId_seq: { runId: data.runId, seq: data.seq } },
      });
      if (exists) throw new EvidenceSequenceConflict(data.runId);
    }
    throw error;
  }
}

export function lastRecord(prisma: PrismaClient, runId: string) {
  return prisma.evidenceRecord.findFirst({ where: { runId }, orderBy: { seq: "desc" } });
}

export function recordsForRun(prisma: PrismaClient, runId: string) {
  return prisma.evidenceRecord.findMany({ where: { runId }, orderBy: { seq: "asc" } });
}

export async function insertSeal(
  prisma: PrismaClient,
  data: Prisma.EvidenceSealUncheckedCreateInput,
) {
  return prisma.$transaction(async (tx) => {
    await lockRun(tx, data.runId);
    const existing = await tx.evidenceSeal.findUnique({ where: { runId: data.runId } });
    if (existing) return existing;
    const head = await tx.evidenceRecord.findFirst({
      where: { runId: data.runId },
      orderBy: { seq: "desc" },
    });
    if (!head || head.sha256 !== data.headSha256 || head.seq + 1 !== data.recordCount) {
      throw new EvidenceSequenceConflict(data.runId);
    }
    return tx.evidenceSeal.create({ data });
  });
}

export function activeEvidenceKey(prisma: PrismaClient, spaceId: string) {
  return prisma.evidenceKey.findFirst({ where: { spaceId, revokedAt: null } });
}

export function evidenceKeyByKid(prisma: PrismaClient, kid: string) {
  return prisma.evidenceKey.findUnique({ where: { kid } });
}

export async function insertEvidenceKey(
  prisma: PrismaClient,
  data: Prisma.EvidenceKeyUncheckedCreateInput,
) {
  try {
    return await prisma.evidenceKey.create({ data });
  } catch (error) {
    if (isUniqueConflict(error)) {
      const winner = await activeEvidenceKey(prisma, data.spaceId);
      if (winner) return winner;
    }
    throw error;
  }
}

export function createEvidenceStore(prisma: PrismaClient) {
  return {
    recordById: async (id: string) => prisma.evidenceRecord.findUnique({ where: { id } }),
    insertRecord: (data: Prisma.EvidenceRecordUncheckedCreateInput) => insertRecord(prisma, data),
    lastRecord: (runId: string) => lastRecord(prisma, runId),
    firstRecord: (runId: string) =>
      prisma.evidenceRecord.findUnique({ where: { runId_seq: { runId, seq: 0 } } }),
    recordsForRun: (runId: string) => recordsForRun(prisma, runId),
    insertSeal: (data: Prisma.EvidenceSealUncheckedCreateInput) => insertSeal(prisma, data),
    sealForRun: (runId: string) => prisma.evidenceSeal.findUnique({ where: { runId } }),
    activeKey: (spaceId: string) => activeEvidenceKey(prisma, spaceId),
    keyByKid: (kid: string) => evidenceKeyByKid(prisma, kid),
    insertKey: (data: Prisma.EvidenceKeyUncheckedCreateInput) => insertEvidenceKey(prisma, data),
    governanceEnabled: async (spaceId: string) =>
      (
        await prisma.spaceFeature.findUnique({
          where: { spaceId_feature: { spaceId, feature: "governance" } },
        })
      )?.state === "enabled",
    noteGap: async (runId: string) => {
      await prisma.run.update({
        where: { id: runId },
        data: { evidenceGapCount: { increment: 1 } },
      });
    },
    gapCount: async (runId: string) =>
      (await prisma.run.findUnique({ where: { id: runId }, select: { evidenceGapCount: true } }))
        ?.evidenceGapCount ?? 0,
  };
}

type StoreFunctions = ReturnType<typeof createEvidenceStore>;
export type EvidenceStore = {
  [K in keyof StoreFunctions]: (
    ...args: Parameters<StoreFunctions[K]>
  ) => Promise<Awaited<ReturnType<StoreFunctions[K]>>>;
};
