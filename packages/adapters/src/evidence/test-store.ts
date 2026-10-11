import type { EvidenceStore } from "@ardurbot/db";
import { EvidenceKeyConflict, EvidenceSequenceConflict } from "@ardurbot/db";
import { vi } from "vitest";

export function fakeEvidenceStore(): {
  store: EvidenceStore;
  records: Awaited<ReturnType<EvidenceStore["recordsForRun"]>>;
  keys: NonNullable<Awaited<ReturnType<EvidenceStore["activeKey"]>>>[];
  seals: NonNullable<Awaited<ReturnType<EvidenceStore["sealForRun"]>>>[];
} {
  const records: Awaited<ReturnType<EvidenceStore["recordsForRun"]>> = [];
  const keys: NonNullable<Awaited<ReturnType<EvidenceStore["activeKey"]>>>[] = [];
  const seals: NonNullable<Awaited<ReturnType<EvidenceStore["sealForRun"]>>>[] = [];
  const gaps = new Map<string, number>();
  const store: EvidenceStore = {
    recordById: async (id) => records.find((row) => row.id === id) ?? null,
    governanceEnabled: vi.fn(async () => true),
    lastRecord: async (runId) =>
      records.filter((row) => row.runId === runId).sort((a, b) => b.seq - a.seq)[0] ?? null,
    firstRecord: async (runId) =>
      records.find((row) => row.runId === runId && row.seq === 0) ?? null,
    recordsForRun: async (runId) =>
      records.filter((row) => row.runId === runId).sort((a, b) => a.seq - b.seq),
    insertRecord: vi.fn(async (data) => {
      if (records.some((row) => row.runId === data.runId && row.seq === data.seq))
        throw new EvidenceSequenceConflict(data.runId);
      const row = {
        ...data,
        id: data.id ?? `record-${records.length}`,
        createdAt: new Date(),
        parentSha256: data.parentSha256 ?? null,
      } as (typeof records)[number];
      records.push(row);
      return row;
    }),
    activeKey: async (spaceId) =>
      keys.find((row) => row.spaceId === spaceId && !row.revokedAt) ?? null,
    keysForSpace: async (spaceId) =>
      keys.filter((row) => row.spaceId === spaceId).sort((a, b) => a.version - b.version),
    keyByKid: async (kid) => keys.find((row) => row.kid === kid) ?? null,
    insertKey: async (data) => {
      const existing = keys.find((row) => row.spaceId === data.spaceId && !row.revokedAt);
      if (existing) return existing;
      const row = {
        ...data,
        id: `key-${keys.length}`,
        version: data.version ?? 1,
        createdAt: new Date(),
        replacedAt: null,
        revokedAt: null,
        revokedReason: null,
      } as (typeof keys)[number];
      keys.push(row);
      return row;
    },
    replaceKey: async ({ spaceId, expectedKid, data }) => {
      const head = keys
        .filter((row) => row.spaceId === spaceId)
        .sort((a, b) => b.version - a.version)[0];
      if (!head || head.kid !== expectedKid) throw new EvidenceKeyConflict(spaceId);
      if (!head.revokedAt) {
        head.revokedAt = new Date();
        head.replacedAt = new Date();
      }
      const row = {
        ...data,
        id: `key-${keys.length}`,
        spaceId,
        version: head.version + 1,
        createdAt: new Date(),
        replacedAt: null,
        revokedAt: null,
        revokedReason: null,
      } as (typeof keys)[number];
      keys.push(row);
      return row;
    },
    revokeKey: async ({ spaceId, expectedKid, reason }) => {
      const current = keys.find((row) => row.spaceId === spaceId && !row.revokedAt);
      if (!current || current.kid !== expectedKid) throw new EvidenceKeyConflict(spaceId);
      current.revokedAt = new Date();
      current.revokedReason = reason;
      return current;
    },
    sealForRun: async (runId) => seals.find((row) => row.runId === runId) ?? null,
    insertSeal: async (data) => {
      const existing = seals.find((row) => row.runId === data.runId);
      if (existing) return existing;
      const row = {
        ...data,
        id: `seal-${seals.length}`,
        createdAt: new Date(),
      } as (typeof seals)[number];
      seals.push(row);
      return row;
    },
    noteGap: async (runId) => {
      gaps.set(runId, (gaps.get(runId) ?? 0) + 1);
    },
    gapCount: async (runId) => gaps.get(runId) ?? 0,
  };
  return { store, records, keys, seals };
}
