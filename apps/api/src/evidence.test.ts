import { generateEvidenceKey, verifyChain, verifySeal } from "@ardurbot/adapters/evidence-format";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createEvidenceRecorder } from "../../../packages/adapters/src/evidence/recorder.js";
import { fakeEvidenceStore } from "../../../packages/adapters/src/evidence/test-store.js";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets.js";
import {
  evidenceKeyHistory,
  mountEvidenceRoutes,
  replaceSpaceEvidenceKey,
  revokeSpaceEvidenceKey,
  runEvidenceSummary,
} from "./evidence.js";
import { extractEvidenceArchive, signedRunFixture } from "./evidence-test-fixture.js";

const actor: Actor = {
  userId: "viewer",
  spaceId: "space",
  email: "viewer@example.test",
  isDeploymentOwner: false,
};
function fixture(role: string | null = "owner") {
  const signed = signedRunFixture();
  const run = {
    id: "run",
    spaceId: "space",
    botId: "bot",
    threadId: "thread",
    thread: { groupId: null },
    status: "completed",
    createdAt: new Date(),
    startedAt: null,
    evidenceGapCount: 0,
  };
  const records = vi.fn(async () => signed.records);
  const seal = vi.fn(async () => signed.seal as typeof signed.seal | null);
  const prisma = {
    spaceMember: { findUnique: vi.fn(async () => (role ? { role } : null)) },
    run: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === run.id && where.spaceId === run.spaceId ? run : null,
      ),
    },
    bot: {
      findFirst: vi.fn(async ({ where }) =>
        where.userId === actor.userId
          ? { id: "bot", thread: { id: "thread" }, computer: null }
          : null,
      ),
    },
    evidenceRecord: { findMany: records },
    evidenceSeal: { findUnique: seal },
    evidenceKey: {
      findFirst: vi.fn(async () => ({
        spaceId: "space",
        publicKeyPem: signed.keys.publicKeyPem,
        version: 1,
      })),
      findUnique: vi.fn(async () => ({
        spaceId: "space",
        publicKeyPem: signed.keys.publicKeyPem,
        version: 1,
        revokedAt: null,
      })),
    },
  } as unknown as PrismaClient;
  const app = new Hono();
  mountEvidenceRoutes(app, prisma, async () => actor);
  return {
    signed,
    run,
    records,
    seal,
    prisma,
    download: () => app.request("/api/evidence/runs/run?spaceId=space"),
  };
}

describe("run evidence", () => {
  it("returns only the public identity fields and compares the verified signing key", async () => {
    const f = fixture();
    const identity = {
      fingerprint: f.signed.keys.kid,
      scope: { type: "space", id: "space" },
      keyVersion: 1,
    };
    vi.mocked(f.prisma.evidenceKey.findFirst).mockResolvedValue({
      ...identity,
      spaceId: "space",
      publicKeyPem: f.signed.keys.publicKeyPem,
      version: 1,
      privateKeyPem: f.signed.keys.privateKeyPem,
      privateKeyCiphertext: "must-not-leak",
      secretRecordId: "must-not-leak",
    } as never);
    const result = await runEvidenceSummary(f.prisma, actor, "run");
    expect(result.signingIdentity).toEqual(identity);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("BEGIN");
    expect(JSON.stringify(result).includes(f.signed.keys.privateKeyPem)).toBe(false);
    expect(result.signerMatch).toBe("no_expected_key");
    expect((await runEvidenceSummary(f.prisma, actor, "run", f.signed.keys.kid)).signerMatch).toBe(
      "expected_key",
    );
    expect(
      (await runEvidenceSummary(f.prisma, actor, "run", `sha256:${"0".repeat(64)}`)).signerMatch,
    ).toBe("different_key");
    expect(f.prisma.evidenceKey.findFirst).toHaveBeenCalledWith({
      where: { spaceId: "space", revokedAt: null },
      select: { publicKeyPem: true, spaceId: true, version: true },
    });
    f.run.status = "running";
    expect(
      (await runEvidenceSummary(f.prisma, actor, "run", f.signed.keys.kid)).signerMatch,
    ).toBeNull();
    f.run.status = "completed";
    f.seal.mockResolvedValue(null);
    expect(
      (await runEvidenceSummary(f.prisma, actor, "run", f.signed.keys.kid)).signerMatch,
    ).toBeNull();
  });
  it("reports a substituted valid bundle and key as a different signer", async () => {
    const f = fixture();
    const replacement = signedRunFixture();
    f.records.mockResolvedValue(replacement.records);
    f.seal.mockResolvedValue(replacement.seal);
    vi.mocked(f.prisma.evidenceKey.findUnique).mockResolvedValue({
      spaceId: "space",
      publicKeyPem: replacement.keys.publicKeyPem,
    } as never);
    expect(await runEvidenceSummary(f.prisma, actor, "run", f.signed.keys.kid)).toMatchObject({
      state: "verified",
      signerMatch: "different_key",
    });
    replacement.records[0]!.jws = "corrupted";
    expect(
      (await runEvidenceSummary(f.prisma, actor, "run", replacement.keys.kid)).signerMatch,
    ).toBeNull();
  });
  it.each([false, true])(
    "summarizes real tool recording with governance enabled=%s",
    async (enabled) => {
      const f = fixture();
      const fake = fakeEvidenceStore();
      vi.mocked(fake.store.governanceEnabled).mockResolvedValue(enabled);
      const recorder = createEvidenceRecorder({
        store: fake.store,
        secretStore: new EncryptedSecretStore("test-only-encryption-material"),
      });
      for (const toolName of ["remember", "shell", "skill_read"]) {
        expect(
          await recorder.recordDecision({
            run: { ...f.run, userId: actor.userId },
            toolName,
            viaConnector: false,
            args: {},
            decisionKind: "allowed_by_default",
          }),
        ).toEqual({ ok: true });
      }
      expect(await recorder.sealRunEvidence(f.run.id)).toEqual({ ok: true });
      f.records.mockImplementation(() => fake.store.recordsForRun(f.run.id) as never);
      f.seal.mockImplementation(() => fake.store.sealForRun(f.run.id) as never);
      vi.mocked(f.prisma.evidenceKey.findUnique).mockImplementation(
        ({ where }) => fake.store.keyByKid(where.kid!) as never,
      );
      expect(await runEvidenceSummary(f.prisma, actor, "run")).toMatchObject({
        state: enabled ? "verified" : "off",
        sealed: enabled,
        failureCodes: [],
        decisions: { recorded: enabled ? 3 : 0 },
      });
      if (enabled) {
        fake.records[1]!.jws = "corrupted";
        expect(await runEvidenceSummary(f.prisma, actor, "run")).toMatchObject({
          state: "failed",
          sealed: false,
          failureCodes: expect.arrayContaining(["malformed_jws"]),
        });
      }
    },
  );
  it.each(["owner", "member"])(
    "allows a %s who can see the run to summarize and download",
    async (role) => {
      const f = fixture(role);
      const summary = await runEvidenceSummary(f.prisma, actor, "run");
      expect(summary).toMatchObject({
        sessionId: "run",
        state: "verified",
        sealed: true,
        captureLevel: "decisions",
        decisions: { allowed: 1, denied: 1, asked: 1, recorded: 3 },
        gates: { spend: null, risks: [] },
        evidence: { encrypted: false, keyId: f.signed.keys.kid },
      });
      const response = await f.download();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="ardur-evidence-run.tar.gz"',
      );
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
      expect(verifyChain(journal, files.get("evidence-public.pem")!).ok).toBe(true);
      expect(
        verifySeal(files.get("seal.jwt")!.trim(), journal, files.get("evidence-public.pem")!).ok,
      ).toBe(true);
    },
  );
  it("returns 404 to nonmembers before reading evidence", async () => {
    const f = fixture(null);
    await expect(runEvidenceSummary(f.prisma, actor, "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await f.download()).status).toBe(404);
    expect(f.records).not.toHaveBeenCalled();
  });
  it("returns 404 for another space's run", async () => {
    const f = fixture();
    f.run.spaceId = "other";
    await expect(runEvidenceSummary(f.prisma, actor, "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await f.download()).status).toBe(404);
    expect(f.records).not.toHaveBeenCalled();
  });
  it("does not grant thread access merely for being a space member", async () => {
    const f = fixture("member");
    vi.mocked(f.prisma.bot.findFirst).mockResolvedValue(null);
    await expect(runEvidenceSummary(f.prisma, actor, "run")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await f.download()).status).toBe(404);
    expect(f.records).not.toHaveBeenCalled();
  });
  it("keeps a run without evidence invisible regardless of current feature state", async () => {
    const f = fixture();
    f.records.mockResolvedValue([]);
    f.seal.mockResolvedValue(null);
    expect((await runEvidenceSummary(f.prisma, actor, "run")).state).toBe("off");
    expect(await (await f.download()).json()).toEqual({
      error: "Evidence is not available for download.",
      state: "off",
    });
  });
  it.each(["running", "completed", "failed", "cancelled"])(
    "reports %s with records but no seal honestly",
    async (status) => {
      const f = fixture();
      f.run.status = status;
      f.seal.mockResolvedValue(null);
      const expected = status === "running" ? "recording" : "unsealed";
      expect((await runEvidenceSummary(f.prisma, actor, "run")).state).toBe(expected);
      const response = await f.download();
      expect(response.status).toBe(409);
      expect((await response.json()).state).toBe(expected);
    },
  );
  it("reports verified gaps with their count and permits the sealed download", async () => {
    const f = fixture();
    f.run.evidenceGapCount = 2;
    expect(await runEvidenceSummary(f.prisma, actor, "run")).toMatchObject({
      state: "gap",
      gapCount: 2,
      sealed: true,
    });
    expect((await f.download()).status).toBe(200);
  });
  it("only returns failure codes for corrupt evidence, never record contents", async () => {
    const f = fixture();
    f.signed.records[0]!.jws = "private-corrupted-content";
    const summary = await runEvidenceSummary(f.prisma, actor, "run");
    expect(summary).toMatchObject({ state: "failed", sealed: false });
    expect(summary.failureCodes).toContain("malformed_jws");
    expect(JSON.stringify(summary)).not.toContain("private-corrupted-content");
    expect((await f.download()).status).toBe(409);
  });
  it("rejects a correctly signed chain transplanted from a different run", async () => {
    const f = fixture();
    const other = signedRunFixture("other-run");
    f.records.mockResolvedValue(other.records);
    f.seal.mockResolvedValue(other.seal);
    vi.mocked(f.prisma.evidenceKey.findUnique).mockResolvedValue({
      spaceId: "space",
      publicKeyPem: other.keys.publicKeyPem,
    } as never);
    expect(await runEvidenceSummary(f.prisma, actor, "run")).toMatchObject({
      state: "failed",
      failureCodes: ["run_mismatch"],
    });
  });
  it("rejects a correctly signed chain for another bot in the same run", async () => {
    const f = fixture();
    f.run.botId = "other-bot";
    expect(await runEvidenceSummary(f.prisma, actor, "run")).toMatchObject({
      state: "failed",
      failureCodes: ["run_mismatch"],
    });
  });
  it("keeps a run that finishes on its original key verified after an ordinary replacement", async () => {
    const f = fixture();
    const fake = fakeEvidenceStore();
    vi.mocked(fake.store.governanceEnabled).mockResolvedValue(true);
    const recorder = createEvidenceRecorder({
      store: fake.store,
      secretStore: new EncryptedSecretStore("test-only-encryption-material"),
    });
    const runInput = {
      run: { ...f.run, userId: actor.userId },
      toolName: "shell",
      viaConnector: false,
      args: {},
      decisionKind: "allowed_by_default" as const,
    };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
      await recorder.recordDecision(runInput);
      await vi.advanceTimersByTimeAsync(60_000);
      // Ordinary replacement: the old key is retained as replaced and the
      // admitted run deliberately keeps signing with it.
      const generated = generateEvidenceKey();
      const stored = await new EncryptedSecretStore("test-only-encryption-material").put(
        generated.privateKeyPem,
        {
          operationId: "evidence-key:test",
          traceId: "trace:test",
          spaceId: "space",
          userId: actor.userId,
          signal: new AbortController().signal,
        },
        "key-rotation-fixture",
      );
      const head = (await fake.store.keysForSpace("space")).at(-1)!;
      await fake.store.replaceKey({
        spaceId: "space",
        expectedKid: head.kid,
        data: {
          kid: generated.kid,
          publicKeyPem: generated.publicKeyPem,
          privateKeyCiphertext: stored.ciphertext,
          secretRecordId: stored.id,
        },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await recorder.recordDecision(runInput);
      expect(await recorder.sealRunEvidence("run")).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
    f.records.mockImplementation(() => fake.store.recordsForRun("run") as never);
    f.seal.mockImplementation(() => fake.store.sealForRun("run") as never);
    vi.mocked(f.prisma.evidenceKey.findUnique).mockImplementation(
      ({ where }) => fake.store.keyByKid(where.kid!) as never,
    );
    const summary = await runEvidenceSummary(f.prisma, actor, "run");
    expect(summary).toMatchObject({ state: "verified", sealed: true, failureCodes: [] });
    expect((await f.download()).status).toBe(200);
  });
  it("keeps pre-revocation records verified and names the revocation date", async () => {
    const f = fixture();
    // The fixture journal is signed at test time; a revocation one minute in
    // the future leaves it fully trusted.
    const revokedAt = new Date(Date.now() + 60_000);
    vi.mocked(f.prisma.evidenceKey.findUnique).mockResolvedValue({
      spaceId: "space",
      publicKeyPem: f.signed.keys.publicKeyPem,
      version: 1,
      revokedAt,
    } as never);
    const summary = await runEvidenceSummary(f.prisma, actor, "run");
    // The fixture journal is dated before the revocation and still verifies.
    expect(summary.state).toBe("verified");
    expect(summary.evidence).toMatchObject({ keyRevision: 1 });
    expect(summary.evidence?.revocationListRevision).toBe(revokedAt.toISOString());
  });
});

describe("evidence key management", () => {
  interface KeyRow {
    id: string;
    spaceId: string;
    kid: string;
    publicKeyPem: string;
    privateKeyCiphertext: string;
    secretRecordId: string;
    version: number;
    createdAt: Date;
    replacedAt: Date | null;
    revokedAt: Date | null;
    revokedReason: string | null;
  }
  function keyFixture(role: string | null) {
    const generated = generateEvidenceKey();
    const rows: KeyRow[] = [
      {
        id: "key-1",
        spaceId: "space",
        kid: generated.kid,
        publicKeyPem: generated.publicKeyPem,
        privateKeyCiphertext: "fixture-ciphertext",
        secretRecordId: "fixture-record",
        version: 1,
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
        replacedAt: null,
        revokedAt: null,
        revokedReason: null,
      },
    ];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      evidenceKey: {
        findMany: vi.fn(
          async (args: {
            where: { spaceId: string };
            orderBy: { version: string };
            take?: number;
          }) => {
            const sorted = rows
              .filter((row) => row.spaceId === args.where.spaceId)
              .sort((a, b) =>
                args.orderBy.version === "desc" ? b.version - a.version : a.version - b.version,
              );
            return args.take ? sorted.slice(0, args.take) : sorted;
          },
        ),
        findFirst: vi.fn(
          async (args: { where: { spaceId: string; revokedAt: null } }) =>
            rows.find((row) => row.spaceId === args.where.spaceId && row.revokedAt === null) ??
            null,
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<KeyRow> }) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error("missing key");
          Object.assign(row, data);
          return row;
        }),
        create: vi.fn(async ({ data }: { data: Partial<KeyRow> }) => {
          const row = {
            id: `key-${rows.length + 1}`,
            createdAt: new Date(),
            replacedAt: null,
            revokedAt: null,
            revokedReason: null,
            ...data,
          } as KeyRow;
          rows.push(row);
          return row;
        }),
      },
    };
    const prisma = {
      spaceMember: { findUnique: vi.fn(async () => (role ? { role } : null)) },
      evidenceKey: {
        findMany: tx.evidenceKey.findMany,
      },
      $transaction: vi.fn(async (fn: (tx: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    const secrets = {
      put: vi.fn(async (_plaintext: string, _context: unknown, recordId: string) => ({
        id: recordId,
        ciphertext: "fixture-ciphertext",
      })),
    };
    return { prisma, secrets, rows, tx };
  }
  it("replaces the head key for an owner with an authenticated session", async () => {
    const f = keyFixture("owner");
    const history = await replaceSpaceEvidenceKey(
      { prisma: f.prisma, secrets: f.secrets },
      actor,
      "session-1",
      f.rows[0]!.kid,
    );
    expect(history.canManage).toBe(true);
    expect(history.keys.map((row) => [row.version, row.state])).toEqual([
      [1, "replaced"],
      [2, "active"],
    ]);
    expect(f.rows[0]).toMatchObject({ version: 1, replacedAt: expect.any(Date) });
    expect(f.rows[1]).toMatchObject({
      version: 2,
      kid: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(f.secrets.put).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(history)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(history)).not.toContain("fixture-ciphertext");
  });
  it("refuses members, paired devices and nonmembers from replacing or revoking", async () => {
    for (const [role, session] of [
      ["member", "session-1"],
      ["owner", undefined],
    ] as const) {
      const f = keyFixture(role);
      await expect(
        replaceSpaceEvidenceKey(
          { prisma: f.prisma, secrets: f.secrets },
          actor,
          session,
          f.rows[0]!.kid,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        revokeSpaceEvidenceKey(f.prisma, actor, session, f.rows[0]!.kid, "lost device"),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.tx.evidenceKey.create).not.toHaveBeenCalled();
      expect(f.secrets.put).not.toHaveBeenCalled();
    }
    const outsider = keyFixture(null);
    await expect(
      replaceSpaceEvidenceKey(
        { prisma: outsider.prisma, secrets: outsider.secrets },
        actor,
        "session-1",
        outsider.rows[0]!.kid,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("maps a raced replacement to a conflict instead of overwriting", async () => {
    const f = keyFixture("owner");
    await expect(
      replaceSpaceEvidenceKey(
        { prisma: f.prisma, secrets: f.secrets },
        actor,
        "session-1",
        "sha256:stale",
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.rows).toHaveLength(1);
  });
  it("emergency revocation is dated, reasoned and owner-only", async () => {
    const f = keyFixture("owner");
    const history = await revokeSpaceEvidenceKey(
      f.prisma,
      actor,
      "session-1",
      f.rows[0]!.kid,
      "compromised",
    );
    expect(history.keys[0]).toMatchObject({
      state: "revoked",
      revokedReason: "compromised",
      revokedAt: expect.any(String),
      replacedAt: null,
    });
    const refused = keyFixture("owner");
    await expect(
      revokeSpaceEvidenceKey(refused.prisma, actor, undefined, refused.rows[0]!.kid, "compromised"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(refused.rows[0]?.revokedAt).toBeNull();
  });
  it("shares key history as public-only with a manage hint for owner sessions", async () => {
    const owner = keyFixture("owner");
    expect(await evidenceKeyHistory(owner.prisma, actor, "session-1")).toMatchObject({
      canManage: true,
      keys: [
        {
          keyId: owner.rows[0]!.kid,
          version: 1,
          state: "active",
          revokedReason: null,
        },
      ],
    });
    const member = keyFixture("member");
    expect((await evidenceKeyHistory(member.prisma, actor, "session-1")).canManage).toBe(false);
    // Paired devices act with the owner's membership but hold no authenticated session.
    const device = keyFixture("owner");
    expect((await evidenceKeyHistory(device.prisma, actor)).canManage).toBe(false);
    const outsider = keyFixture(null);
    await expect(evidenceKeyHistory(outsider.prisma, actor, "session-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const history = await evidenceKeyHistory(owner.prisma, actor, "session-1");
    expect(JSON.stringify(history)).not.toContain("fixture-ciphertext");
    expect(JSON.stringify(history)).not.toContain("PRIVATE KEY");
  });
  it("redacts credentials from the revocation reason before storing it", async () => {
    const f = keyFixture("owner");
    const apiToken = "sk-live4eC39HqLyjWDartJzT1zdp7dc51Js";
    const pemBody = "MIIEpAIBAAKCAQEA7d1fK7fG6vBQ8mY3xYzL9vN0pQrS2tT5uVwX8yZaBcD4eF7h";
    const reason = [
      `rotating after leak of ${apiToken}`,
      "-----BEGIN RSA PRIVATE KEY-----",
      pemBody,
      "-----END RSA PRIVATE KEY-----",
      "please review",
    ].join("\n");
    const history = await revokeSpaceEvidenceKey(
      f.prisma,
      actor,
      "session-1",
      f.rows[0]!.kid,
      reason,
    );
    const stored = f.rows[0]?.revokedReason ?? "";
    // Boolean assertions keep any leaked material out of test output.
    expect(stored.includes(apiToken)).toBe(false);
    expect(stored.includes(pemBody)).toBe(false);
    expect(stored.includes("PRIVATE KEY")).toBe(false);
    expect(stored).toContain("[Redacted]");
    expect(stored).toContain("please review");
    expect(history.keys[0]?.revokedReason).toBe(stored);
  });
  it("bounds the stored revocation reason length", async () => {
    const f = keyFixture("owner");
    await revokeSpaceEvidenceKey(f.prisma, actor, "session-1", f.rows[0]!.kid, "a".repeat(500));
    expect(f.rows[0]?.revokedReason).toHaveLength(200);
  });
  it("shows the free-text reason only to the owner with an authenticated session", async () => {
    const f = keyFixture("owner");
    f.rows[0]!.revokedAt = new Date("2026-10-02T00:00:00.000Z");
    f.rows[0]!.revokedReason = "compromised fixture";
    expect((await evidenceKeyHistory(f.prisma, actor, "session-1")).keys[0]?.revokedReason).toBe(
      "compromised fixture",
    );
    // Members and paired devices see the revocation time and state only.
    expect((await evidenceKeyHistory(f.prisma, actor)).keys[0]?.revokedReason).toBeNull();
    const member = keyFixture("member");
    member.rows[0]!.revokedAt = new Date("2026-10-02T00:00:00.000Z");
    member.rows[0]!.revokedReason = "compromised fixture";
    expect(
      (await evidenceKeyHistory(member.prisma, actor, "session-1")).keys[0]?.revokedReason,
    ).toBeNull();
  });
});
