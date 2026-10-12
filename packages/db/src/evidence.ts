import type { Prisma, PrismaClient } from "./client.js";

export class EvidenceSequenceConflict extends Error {
  constructor(readonly runId: string) {
    super("Evidence sequence already exists");
    this.name = "EvidenceSequenceConflict";
  }
}

export class EvidenceKeyConflict extends Error {
  constructor(readonly spaceId: string) {
    super("The active evidence key changed. Reload the signing identity and try again.");
    this.name = "EvidenceKeyConflict";
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function lockRun(tx: Prisma.TransactionClient, runId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evidence:${runId}`}, 0))::text AS "lock"`;
}

async function lockSpaceKeys(tx: Prisma.TransactionClient, spaceId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evidence-key:${spaceId}`}, 0))::text AS "lock"`;
}

async function activeKeyForUpdate(tx: Prisma.TransactionClient, spaceId: string) {
  return tx.evidenceKey.findFirst({ where: { spaceId, revokedAt: null } });
}

/**
 * Shared fence for every signature write. Emergency revocation takes the same
 * space-key lock, so re-checking the key row inside this transaction means no
 * record or seal lands after a committed revocation. A replaced key stays
 * signable: runs admitted before a rotation keep their key by design.
 */
async function assertKeyStillSignable(
  tx: Prisma.TransactionClient,
  spaceId: string,
  kid: string | null | undefined,
) {
  if (!kid) return;
  await lockSpaceKeys(tx, spaceId);
  const row = await tx.evidenceKey.findUnique({
    where: { kid },
    select: { revokedAt: true, replacedAt: true },
  });
  if (row?.revokedAt && !row.replacedAt) throw new Error("Evidence key revoked");
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
      await assertKeyStillSignable(tx, data.spaceId, data.kid);
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
    await assertKeyStillSignable(tx, data.spaceId, head.kid);
    return tx.evidenceSeal.create({ data });
  });
}

export function activeEvidenceKey(prisma: PrismaClient, spaceId: string) {
  return prisma.evidenceKey.findFirst({ where: { spaceId, revokedAt: null } });
}

export function evidenceKeysForSpace(prisma: PrismaClient, spaceId: string) {
  return prisma.evidenceKey.findMany({ where: { spaceId }, orderBy: { version: "asc" } });
}

/**
 * Atomically replace the space's head key: succeeds only when the latest key
 * is still the expected one, so two replacements cannot both win. The head is
 * the active key, or — after an emergency revocation — the newest revoked
 * key. The old row is retained (marked replaced) for historical verification.
 */
export async function replaceEvidenceKey(
  prisma: PrismaClient,
  args: {
    spaceId: string;
    expectedKid: string;
    data: Omit<Prisma.EvidenceKeyUncheckedCreateInput, "spaceId" | "version">;
  },
) {
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSpaceKeys(tx, args.spaceId);
      const head = (
        await tx.evidenceKey.findMany({
          where: { spaceId: args.spaceId },
          orderBy: { version: "desc" },
          take: 1,
        })
      )[0];
      if (!head || head.kid !== args.expectedKid) throw new EvidenceKeyConflict(args.spaceId);
      if (!head.revokedAt) {
        await tx.evidenceKey.update({
          where: { id: head.id },
          data: { revokedAt: new Date(), replacedAt: new Date() },
        });
      }
      return tx.evidenceKey.create({
        data: { ...args.data, spaceId: args.spaceId, version: head.version + 1 },
      });
    });
  } catch (error) {
    if (isUniqueConflict(error)) throw new EvidenceKeyConflict(args.spaceId);
    throw error;
  }
}

/** Emergency revocation: the active key stops signing at once; the row is kept. */
export async function revokeEvidenceKey(
  prisma: PrismaClient,
  args: { spaceId: string; expectedKid: string; reason: string },
) {
  return prisma.$transaction(async (tx) => {
    await lockSpaceKeys(tx, args.spaceId);
    const current = await activeKeyForUpdate(tx, args.spaceId);
    if (!current || current.kid !== args.expectedKid) throw new EvidenceKeyConflict(args.spaceId);
    return tx.evidenceKey.update({
      where: { id: current.id },
      data: { revokedAt: new Date(), revokedReason: args.reason },
    });
  });
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
    keysForSpace: (spaceId: string) => evidenceKeysForSpace(prisma, spaceId),
    keyByKid: (kid: string) => evidenceKeyByKid(prisma, kid),
    insertKey: (data: Prisma.EvidenceKeyUncheckedCreateInput) => insertEvidenceKey(prisma, data),
    replaceKey: (args: {
      spaceId: string;
      expectedKid: string;
      data: Omit<Prisma.EvidenceKeyUncheckedCreateInput, "spaceId" | "version">;
    }) => replaceEvidenceKey(prisma, args),
    revokeKey: (args: { spaceId: string; expectedKid: string; reason: string }) =>
      revokeEvidenceKey(prisma, args),
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
