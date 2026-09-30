import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { insertRecord, insertSeal } from "./evidence.js";

describe("evidence advisory lock SQL", () => {
  it.each(["record", "seal"])(
    "casts the %s lock result to a Prisma-supported type",
    async (kind) => {
      const query = vi.fn(async (sql: TemplateStringsArray, key: string) => {
        expect(sql.join("?")).toBe(
          'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))::text AS "lock"',
        );
        expect(key).toBe("evidence:run-test");
        return [{ lock: "" }];
      });
      const tx = {
        $queryRaw: query,
        evidenceRecord: {
          create: vi.fn(async () => ({})),
          findFirst: vi.fn(async () => ({ sha256: "head", seq: 0 })),
        },
        evidenceSeal: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      };
      const prisma = {
        $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      } as unknown as PrismaClient;
      if (kind === "record") {
        await insertRecord(prisma, {
          runId: "run-test",
          spaceId: "space-test",
          seq: 0,
          receiptId: "receipt-test",
          kid: "key-test",
          jws: "fixture",
          sha256: "head",
          verdict: "compliant",
          decisionKind: "allowed_by_default",
          toolName: "read_file",
        });
        expect(tx.evidenceRecord.create).toHaveBeenCalledOnce();
      } else {
        await insertSeal(prisma, {
          runId: "run-test",
          spaceId: "space-test",
          jws: "fixture",
          headSha256: "head",
          recordCount: 1,
          gapCount: 0,
        });
        expect(tx.evidenceSeal.create).toHaveBeenCalledOnce();
      }
      expect(query).toHaveBeenCalledOnce();
    },
  );
});
