import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { insertRecord, insertSeal } from "./evidence.js";

function stub(keys: { revokedAt: Date | null; replacedAt: Date | null } | null) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    evidenceKey: { findUnique: vi.fn(async () => keys) },
    evidenceRecord: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
      create: vi.fn(async ({ data }: { data: unknown }) => data),
    },
    evidenceSeal: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: unknown }) => data),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx };
}

const recordData = {
  spaceId: "space",
  runId: "run",
  seq: 0,
  receiptId: "receipt",
  kid: "kid",
  jws: "jws",
  sha256: "hash",
  parentSha256: null,
  verdict: "compliant",
  decisionKind: "allowed_by_default",
  toolName: "read_file",
} as Prisma.EvidenceRecordUncheckedCreateInput;

const sealData = {
  spaceId: "space",
  runId: "run",
  jws: "seal",
  headSha256: "hash",
  recordCount: 1,
  gapCount: 0,
} as Prisma.EvidenceSealUncheckedCreateInput;

describe("evidence advisory lock SQL", () => {
  const LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))::text AS "lock"';
  function stubLocks() {
    const calls: { sql: string; key: string }[] = [];
    const query = vi.fn(async (sql: TemplateStringsArray, key: string) => {
      calls.push({ sql: sql.join("?"), key });
      return [{ lock: "" }];
    });
    const tx = {
      $queryRaw: query,
      evidenceKey: {
        findUnique: vi.fn(async () => ({ revokedAt: null, replacedAt: null })),
      },
      evidenceRecord: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => ({ seq: 0, sha256: "head", kid: "key-test" })),
        create: vi.fn(async () => ({})),
      },
      evidenceSeal: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as PrismaClient;
    return { prisma, tx, calls };
  }
  it.each(["record", "seal"] as const)(
    "casts the %s lock results to a Prisma-supported type with the run and space keys",
    async (kind) => {
      const { prisma, tx, calls } = stubLocks();
      if (kind === "record") {
        await insertRecord(prisma, {
          ...recordData,
          runId: "run-test",
          spaceId: "space-test",
          kid: "key-test",
        });
        expect(tx.evidenceRecord.create).toHaveBeenCalledOnce();
      } else {
        await insertSeal(prisma, {
          ...sealData,
          runId: "run-test",
          spaceId: "space-test",
          headSha256: "head",
        });
        expect(tx.evidenceSeal.create).toHaveBeenCalledOnce();
      }
      // Run lock first, then the space-key fence that serializes with revocation.
      expect(calls.map((call) => call.sql)).toEqual([LOCK_SQL, LOCK_SQL]);
      expect(calls.map((call) => call.key)).toEqual([
        "evidence:run-test",
        "evidence-key:space-test",
      ]);
    },
  );
});

describe("signature writes fenced against emergency revocation", () => {
  it("refuses a record signed with a key revoked before the write lands", async () => {
    const { prisma, tx } = stub({ revokedAt: new Date(), replacedAt: null });
    await expect(insertRecord(prisma, recordData)).rejects.toThrow(/revoked/i);
    expect(tx.evidenceRecord.create).not.toHaveBeenCalled();
    // Run lock plus the space-key fence that serializes with revocation.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it("refuses a seal signed with a key revoked before the write lands", async () => {
    const { prisma, tx } = stub({ revokedAt: new Date(), replacedAt: null });
    tx.evidenceRecord.findFirst.mockResolvedValue({ seq: 0, sha256: "hash", kid: "kid" });
    await expect(insertSeal(prisma, sealData)).rejects.toThrow(/revoked/i);
    expect(tx.evidenceSeal.create).not.toHaveBeenCalled();
  });
  it.each([
    ["an active", { revokedAt: null, replacedAt: null }],
    ["a replaced", { revokedAt: new Date(), replacedAt: new Date() }],
  ])("still admits a record signed by %s key", async (_name, key) => {
    const { prisma, tx } = stub(key);
    await expect(insertRecord(prisma, recordData)).resolves.toEqual(recordData);
    expect(tx.evidenceRecord.create).toHaveBeenCalledTimes(1);
  });
  it("still admits a seal signed by a replaced key", async () => {
    const { prisma, tx } = stub({ revokedAt: new Date(), replacedAt: new Date() });
    tx.evidenceRecord.findFirst.mockResolvedValue({ seq: 0, sha256: "hash", kid: "kid" });
    await expect(insertSeal(prisma, sealData)).resolves.toEqual(sealData);
    expect(tx.evidenceSeal.create).toHaveBeenCalledTimes(1);
  });
  it("accepts a record when the referenced key row is absent", async () => {
    const { prisma, tx } = stub(null);
    await expect(insertRecord(prisma, recordData)).resolves.toEqual(recordData);
    expect(tx.evidenceRecord.create).toHaveBeenCalledTimes(1);
  });
});
