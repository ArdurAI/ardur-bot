import type { LearningProposal, RuntimePin } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { MemoryService, PostgresDocumentStore } from "@ardurbot/memory";
import { memoryDatabaseFake, serialMemoryLock } from "@ardurbot/testkit/memory-fakes";
import { describe, expect, it, vi } from "vitest";
import { createLearningApplyService } from "./learning-apply.js";
import { applyGrantedLearning } from "./learning-auto-apply.js";
import { createLearningGrants } from "./learning-grants.js";
import { inverseLearningChange } from "./learning-inverse.js";
import { projectLearningObservation } from "./learning-outcomes.js";
import { policySuppressed } from "./learning-policy.js";
import { proposalDiff, proposalFingerprint } from "./learning-proposal.js";
import { parseRevisionMarkdown, revisionMarkdown } from "./memory/markdown-files.js";

const actor = { spaceId: "space", userId: "user" };
const scope = { ...actor, botId: "bot" };
const pin: RuntimePin = {
  runtimeKind: "pi",
  provider: "openai-compatible",
  modelId: "fixture",
  effort: "medium",
  credentialId: "connection",
  revision: 1,
};
type Row = Record<string, unknown>;
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Row[]).some((v) => matches(row, v));
    if (key === "spaceId_userId" || key === "spaceId_userId_fingerprint")
      return matches(row, value as Row);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const condition = value as Row;
      if ("gte" in condition) return Number(row[key]) >= Number(condition.gte);
      if ("gt" in condition) return Number(row[key]) > Number(condition.gt);
      if ("in" in condition) return (condition.in as unknown[]).includes(row[key]);
    }
    return row[key] === value || (row[key] === undefined && value === null);
  });
}
function table(rows: Row[]) {
  return {
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
      rows.filter((row) => matches(row, where)),
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null,
    ),
    findUnique: vi.fn(
      async ({ where }: { where: Row }) => rows.find((row) => matches(row, where)) ?? null,
    ),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Row }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) throw new Error("Missing");
      return row;
    }),
    count: vi.fn(
      async ({ where }: { where: Row }) => rows.filter((row) => matches(row, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `row-${rows.length}`, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) throw new Error("Missing");
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const found = rows.filter((row) => matches(row, where));
      found.forEach((row) => {
        Object.assign(row, data);
      });
      return { count: found.length };
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const row = rows.find((row) => matches(row, where));
      if (row) Object.assign(row, update);
      else rows.push(create);
      return row ?? create;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const kept = rows.filter((row) => !matches(row, where));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count };
    }),
  };
}
function fixture() {
  const proposals: Row[] = [],
    audits: Row[] = [],
    grants: Row[] = [],
    suppressions: Row[] = [],
    skills: Row[] = [],
    filings: Row[] = [];
  const transactions = { open: 0 };
  const bot = { id: "bot", ...actor, notifyOnFinish: true, autoSpeak: false };
  const thread = { id: "thread", ...actor, historyCompactionGeneration: 0 };
  const memoryDb = memoryDatabaseFake();
  const db = {
    ...memoryDb.tx,
    $executeRaw: vi.fn(),
    learningProposal: table(proposals),
    learningAudit: table(audits),
    learningGrant: table(grants),
    learningSuppression: table(suppressions),
    agentSkill: table(skills),
    botBoardFiling: table(filings),
    actionApprovalRule: {
      upsert: vi.fn(async ({ create }: { create: Row }) => ({ id: "rule", ...create })),
    },
    spaceMember: table([{ ...actor, role: "owner" }]),
    bot: table([bot]),
    thread: table([thread]),
    secret: table([]),
    botSecret: table([]),
    run: { findFirst: vi.fn(async () => ({ id: "run", ...scope, runtimePin: pin })) },
    reviewExecution: { findFirst: vi.fn(async () => ({ reviewerPin: pin, policyVersion: "v1" })) },
    spaceLearningConfig: { findUnique: vi.fn(async () => ({ enabled: true })) },
  };
  const mutex = serialMemoryLock();
  const prisma = {
    ...db,
    $transaction: (action: (tx: typeof db) => Promise<unknown>) =>
      mutex(async () => {
        const collections = [proposals, audits, grants, suppressions, skills, filings];
        const snapshot = collections.map((rows) => structuredClone(rows));
        const docs = structuredClone(memoryDb.documents),
          revisions = structuredClone(memoryDb.revisions);
        transactions.open += 1;
        try {
          return await action(db);
        } catch (error) {
          collections.forEach((rows, i) => {
            rows.splice(0, rows.length, ...snapshot[i]!);
          });
          memoryDb.documents.clear();
          for (const [id, doc] of docs) memoryDb.documents.set(id, doc);
          memoryDb.revisions.splice(0, memoryDb.revisions.length, ...revisions);
          throw error;
        } finally {
          transactions.open -= 1;
        }
      }),
  } as unknown as PrismaClient;
  const enqueue = vi.fn(async () => undefined);
  const service = new MemoryService({
    enqueue,
    open: async (context, action) =>
      action({
        access: { ...context, botIds: ["bot"] },
        store: new PostgresDocumentStore(memoryDb.tx),
        generation: 0,
        semantic: { describe: () => ({ id: "fixture" }) } as never,
      }),
  });
  const deps = {
    prisma,
    memoryDocuments: service,
    secretStore: { load: () => "fixture-redaction-value" } as never,
  };
  const apply = createLearningApplyService(deps);
  const context = {
    ...scope,
    operationId: "fixture",
    traceId: "fixture",
    signal: new AbortController().signal,
  };
  async function proposal(before?: string, overrides: Partial<LearningProposal> = {}) {
    const id = `proposal-${proposals.length}`;
    const head =
      before !== undefined
        ? await service.commit(
            { scope: "bot", path: `notes/${id}.md`, content: before, expectedRevision: 0 },
            context,
          )
        : null;
    const body: LearningProposal = {
      id,
      type: "memory",
      scope,
      target: head ? { documentId: head.id } : {},
      expectedBaseRevision: head?.revision ?? 0,
      proposedContent: "Use numbered steps.",
      rationale: "The owner requested this format.",
      evidenceIds: ["evidence"],
      confidence: { label: "model estimate", value: 0.8 },
      status: "pending",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      diff: proposalDiff(before ?? "", "Use numbered steps."),
      ...overrides,
    };
    proposals.push({
      id,
      ...scope,
      runId: "run",
      threadId: "thread",
      historyGeneration: 0,
      status: "pending",
      body,
      fingerprint: proposalFingerprint(body),
      expiresAt: new Date(body.expiresAt),
      createdAt: new Date(),
    });
    return body;
  }
  function grant(extra: Row = {}) {
    const row: Row = {
      id: `grant-${grants.length}`,
      ...actor,
      category: "memory",
      scope: { kind: "bot", botId: "bot" },
      scopeKey: "bot:bot",
      maxPerDay: 5,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date(),
      ...extra,
    };
    grants.push(row);
    return row;
  }
  return {
    deps,
    db,
    apply,
    service,
    context,
    proposal,
    grant,
    proposals,
    audits,
    grants,
    suppressions,
    skills,
    filings,
    transactions,
    bot,
    thread,
    enqueue,
    memoryDb,
  };
}

describe("independent learning consent", () => {
  it("applies at the expected revision, records both pins and approver, and schedules projection", async () => {
    const f = fixture(),
      p = await f.proposal("Before");
    const result = await f.apply.approve(p.id, actor);
    expect(result.proposal).toMatchObject({
      status: "applied",
      appliedRevisionId: `${p.target.documentId}:2`,
    });
    const head = await f.service.read(p.target.documentId!, f.context);
    expect(head).toMatchObject({
      content: p.proposedContent,
      revision: 2,
      author: { kind: "learning-loop", userId: "user" },
      learning: {
        proposalId: p.id,
        approvingUserId: "user",
        originatingPin: pin,
        reviewerPin: pin,
        policyVersion: "v1",
        parentRevision: 1,
      },
    });
    expect(f.audits[0]).toMatchObject({
      action: "approve",
      proposalId: p.id,
      beforeRevisionId: `${head!.id}:1`,
      afterRevisionId: `${head!.id}:2`,
    });
    expect(JSON.stringify(f.audits)).not.toContain(p.proposedContent);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });
  it("marks a stale suggestion superseded without overwriting the head", async () => {
    const f = fixture(),
      p = await f.proposal("Before");
    await f.service.update(p.target.documentId!, "Later", 1, f.context);
    expect((await f.apply.approve(p.id, actor)).proposal).toMatchObject({
      status: "superseded",
      blockedReason: "This changed since the suggestion was made",
    });
    expect((await f.service.read(p.target.documentId!, f.context))?.content).toBe("Later");
  });
  it("refuses protected and repository targets, including a memory proposal aimed at a skill", async () => {
    for (const mode of ["protected", "repository", "wrong-type"]) {
      const f = fixture();
      const head = await f.service.commit(
        { scope: "bot", path: "skills/existing.md", content: "Before", expectedRevision: 0 },
        f.context,
      );
      const p = await f.proposal(undefined, {
        type: mode === "wrong-type" ? "memory" : "skill",
        target: { documentId: head.id },
        expectedBaseRevision: 1,
      });
      f.skills.push({
        id: "skill",
        documentId: head.id,
        ...scope,
        protected: mode === "protected",
        origin: mode === "repository" ? "repository" : "learned",
        source: "learned",
      });
      await expect(f.apply.approve(p.id, actor)).rejects.toThrow();
      expect((await f.service.read(head.id, f.context))?.revision).toBe(1);
    }
  });
  it("rejects and suppresses the original and edited fingerprints without persisting a reason", async () => {
    const f = fixture(),
      p = await f.proposal();
    await f.apply.edit(p.id, actor, { proposedContent: "Use a checklist." });
    await f.apply.reject(p.id, actor, "Private reason");
    expect(f.suppressions).toHaveLength(2);
    expect(JSON.stringify(f.audits)).not.toContain("Private reason");
    const repeat = await f.proposal();
    f.grant();
    await applyGrantedLearning(f.deps, "run");
    expect(f.proposals.find((row) => row.id === repeat.id)?.status).toBe("pending");
  });
  it("redacts edited content, recomputes the diff, and applies that content", async () => {
    const f = fixture(),
      p = await f.proposal("Before");
    f.db.secret.findMany.mockResolvedValueOnce([{ id: "test", ciphertext: "opaque" }]);
    const edited = await f.apply.edit(p.id, actor, {
      proposedContent: "Use a checklist. fixture-redaction-value",
    });
    expect(edited.proposal.diff).toContain("+Use a checklist. [redacted]");
    expect(JSON.stringify(f.proposals)).not.toContain("fixture-redaction-value");
    const result = await f.apply.approve(p.id, actor);
    expect((await f.service.read(result.proposal.documentId!, f.context))?.content).toBe(
      edited.proposal.proposedContent,
    );
  });
  it("undoes the head as a new revision with the parent content", async () => {
    const f = fixture(),
      p = await f.proposal("Before");
    await f.apply.approve(p.id, actor);
    const result = await f.apply.revert(p.id, actor);
    expect(result.proposal).toMatchObject({
      status: "reverted",
      revertedRevisionId: `${p.target.documentId}:3`,
    });
    expect(await f.service.read(p.target.documentId!, f.context)).toMatchObject({
      content: "Before",
      revision: 3,
      learning: { action: "revert", parentRevision: 2 },
    });
    expect(f.audits.at(-1)?.action).toBe("revert");
  });
  it("returns both versions for overlapping later edits and never changes the head", async () => {
    const f = fixture(),
      p = await f.proposal("Before");
    await f.apply.approve(p.id, actor);
    await f.service.update(p.target.documentId!, "Keep this later work", 2, f.context);
    const result = await f.apply.revert(p.id, actor);
    expect(result.conflict).toEqual({
      before: "Before",
      applied: p.proposedContent,
      current: "Keep this later work",
      expectedRevision: 3,
    });
    expect((await f.service.read(p.target.documentId!, f.context))?.revision).toBe(3);
  });
  it("preserves nonoverlapping later work when applying the inverse", async () => {
    const f = fixture(),
      p = await f.proposal("Heading\nOld\nFooter", { proposedContent: "Heading\nNew\nFooter" });
    await f.apply.approve(p.id, actor);
    await f.service.update(p.target.documentId!, "Heading\nNew\nFooter\nLater work", 2, f.context);
    await f.apply.revert(p.id, actor);
    expect((await f.service.read(p.target.documentId!, f.context))?.content).toBe(
      "Heading\nOld\nFooter\nLater work",
    );
  });
  it("tombstones a created document but conflicts if it received later edits", async () => {
    for (const later of [false, true]) {
      const f = fixture(),
        p = await f.proposal();
      const applied = await f.apply.approve(p.id, actor);
      const id = applied.proposal.documentId!;
      if (later) await f.service.update(id, "Keep", 1, f.context);
      const result = await f.apply.revert(p.id, actor);
      const head = await f.service.read(id, f.context);
      expect(head?.deletedAt !== null).toBe(!later);
      expect(Boolean(result.conflict)).toBe(later);
      if (!later) expect(head?.revision).toBe(2);
    }
  });
  it("creates learned skills in the common document catalog", async () => {
    const f = fixture(),
      p = await f.proposal(undefined, {
        type: "skill",
        proposedContent:
          "---\nname: Procedure\ndescription: Repeatable steps\n---\nUse a numbered checklist.",
      });
    await f.apply.approve(p.id, actor);
    expect(f.skills[0]).toMatchObject({
      origin: "learned",
      source: "learned",
      botId: "bot",
      content: "",
      activeRevision: 1,
    });
    expect((await f.service.read(f.skills[0]!.documentId as string, f.context))?.content).toBe(
      p.proposedContent,
    );
  });
  it("only applies typed visible settings and safely undoes them", async () => {
    const f = fixture(),
      p = await f.proposal(undefined, {
        type: "preference",
        proposedContent: undefined,
        typedDelta: { key: "bot.autoSpeak", value: true },
        settingBefore: false,
      });
    await f.apply.approve(p.id, actor);
    expect(f.bot.autoSpeak).toBe(true);
    await f.apply.revert(p.id, actor);
    expect(f.bot.autoSpeak).toBe(false);
    const unsupported = await f.proposal(undefined, {
      type: "preference",
      proposedContent: undefined,
      typedDelta: { key: "hidden.instructions", value: "Do something" },
    });
    expect((await f.apply.approve(unsupported.id, actor)).proposal.status).toBe("pending");
  });
  it("keeps shared skills and display-only categories pending", async () => {
    for (const type of ["skill", "policy-suggestion", "pin-insight", "harness-issue"] as const) {
      const f = fixture(),
        p = await f.proposal(undefined, {
          type,
          ...(type === "skill" ? { scope: { spaceId: "space" } } : {}),
        });
      expect((await f.apply.approve(p.id, actor)).proposal).toMatchObject({
        status: "pending",
        blockedReason: expect.any(String),
      });
      expect(f.memoryDb.documents.size).toBe(0);
    }
  });
  it("refuses cross-space, wrong-owner, expired, missing-member and deleted-source applies", async () => {
    for (const mode of ["space", "owner", "member", "deleted", "expired"]) {
      const f = fixture(),
        p = await f.proposal(
          undefined,
          mode === "expired" ? { expiresAt: "2020-01-01T00:00:00.000Z" } : {},
        );
      if (mode === "member") f.db.spaceMember.findUnique.mockResolvedValueOnce(null);
      if (mode === "deleted") f.thread.historyCompactionGeneration++;
      const action = f.apply.approve(
        p.id,
        mode === "space"
          ? { ...actor, spaceId: "other" }
          : mode === "owner"
            ? { ...actor, userId: "other" }
            : actor,
      );
      if (mode === "expired") expect((await action).proposal.status).toBe("expired");
      else await expect(action).rejects.toThrow();
      expect(f.memoryDb.documents.size).toBe(0);
    }
  });
  it("rolls the document and proposal back if audit persistence fails", async () => {
    const f = fixture(),
      p = await f.proposal();
    f.db.learningAudit.create.mockRejectedValueOnce(new Error("Write failed"));
    await expect(f.apply.approve(p.id, actor)).rejects.toThrow();
    expect(f.memoryDb.documents.size).toBe(0);
    expect(f.proposals[0]?.status).toBe("pending");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});

describe("personal grants", () => {
  it("offers a grant only after five manual approvals in the same category and scope", async () => {
    const f = fixture(),
      service = createLearningGrants(f.deps.prisma);
    for (let i = 0; i < 5; i++) {
      const p = await f.proposal();
      await f.apply.approve(p.id, actor);
      if (i < 4) expect((await service.list(actor)).offers).toEqual([]);
    }
    expect((await service.list(actor)).offers).toEqual([
      { category: "memory", scope: { kind: "bot", botId: "bot" } },
    ]);
    await expect(
      service.create(actor, {
        category: "skill",
        scope: { kind: "bot", botId: "bot" },
        limits: { maxPerDay: 5 },
      }),
    ).rejects.toThrow();
    const grant = await service.create(actor, {
      category: "memory",
      scope: { kind: "bot", botId: "bot" },
      limits: { maxPerDay: 2 },
    });
    expect(grant.limits.maxPerDay).toBe(2);
    expect(f.audits.at(-1)?.action).toBe("grant-created");
    expect((await service.list(actor)).offers).toEqual([]);
    await service.revoke(actor, grant.id);
    expect(f.audits.at(-1)?.action).toBe("grant-revoked");
  });
  it("does not silently turn the offer into a grant and respects Not now", async () => {
    const f = fixture(),
      service = createLearningGrants(f.deps.prisma);
    for (let i = 0; i < 5; i++) {
      const p = await f.proposal();
      await f.apply.approve(p.id, actor);
    }
    expect(f.grants).toEqual([]);
    await service.decline(actor, { category: "memory", scope: { kind: "bot", botId: "bot" } });
    expect((await service.list(actor)).offers).toEqual([]);
  });
  it("the review job cannot call apply without a grant", async () => {
    const f = fixture();
    await f.proposal();
    await applyGrantedLearning(f.deps, "run");
    expect(f.db.learningGrant.findUnique).not.toHaveBeenCalled();
    expect(f.proposals[0]?.status).toBe("pending");
    expect(f.memoryDb.documents.size).toBe(0);
    await expect(f.apply.autoApply("proposal-0", "absent")).rejects.toThrow();
  });
  it("rechecks a revoked, expired, exhausted, disabled or wrong-scope grant at apply time", async () => {
    for (const mode of ["revoked", "expired", "quota", "disabled", "scope", "deleted"]) {
      const f = fixture(),
        p = await f.proposal(),
        grant = f.grant();
      if (mode === "revoked") grant.revokedAt = new Date();
      if (mode === "expired") grant.expiresAt = new Date(0);
      if (mode === "quota") grant.maxPerDay = 0;
      if (mode === "disabled")
        f.db.spaceLearningConfig.findUnique.mockResolvedValueOnce({ enabled: false });
      if (mode === "scope") grant.scopeKey = "user";
      if (mode === "deleted") f.thread.historyCompactionGeneration++;
      await expect(f.apply.autoApply(p.id, grant.id as string)).rejects.toThrow();
      expect(f.memoryDb.documents.size).toBe(0);
    }
  });
  it("applies a matching grant through the same lifecycle and preserves its audit", async () => {
    const f = fixture(),
      p = await f.proposal(),
      grant = f.grant();
    await applyGrantedLearning(f.deps, "run");
    expect(f.proposals[0]?.status).toBe("applied");
    expect(f.audits[0]).toMatchObject({
      action: "auto-apply",
      grantId: grant.id,
      proposalId: p.id,
    });
    expect(f.memoryDb.revisions[0]?.learning).toMatchObject({ grantId: grant.id });
  });
  it("cannot use a personal grant for shared skills or a suppressed fingerprint", async () => {
    const f = fixture(),
      p = await f.proposal(),
      grant = f.grant();
    f.suppressions.push({ ...actor, fingerprint: proposalFingerprint(p) });
    await expect(f.apply.autoApply(p.id, grant.id as string)).rejects.toThrow();
    const shared = await f.proposal(undefined, { type: "skill", scope: { spaceId: "space" } });
    expect((await f.apply.autoApply(shared.id, grant.id as string)).proposal.status).toBe(
      "pending",
    );
    expect(f.memoryDb.documents.size).toBe(0);
  });
});
it("inverse edits fail closed on ambiguous spans and preserve unrelated additions", () => {
  expect(inverseLearningChange("a\nold\nz", "a\nnew\nz", "a\nnew\nz\nlater")).toBe(
    "a\nold\nz\nlater",
  );
  expect(inverseLearningChange("old", "new", "new\nnew")).toBeNull();
  expect(inverseLearningChange("a\nremoved\nz", "a\nz", "later\na\nz")).toBe(
    "later\na\nremoved\nz",
  );
});

it("round-trips learning attribution in portable Markdown and clears it on a manual edit", async () => {
  const f = fixture(),
    p = await f.proposal("Before");
  await f.apply.approve(p.id, actor);
  const head = (await f.service.read(p.target.documentId!, f.context))!;
  expect(parseRevisionMarkdown(revisionMarkdown(head)).learning).toEqual(head.learning);
  await f.service.update(head.id, "Manual change", head.revision, f.context);
  const next = await f.service.read(head.id, f.context);
  expect(next?.learning).toBeUndefined();
  expect(next?.author.kind).toBe("user");
});

it("enforces the daily grant limit after a successful automatic application", async () => {
  const f = fixture(),
    first = await f.proposal(),
    second = await f.proposal(undefined, { proposedContent: "Use headings." });
  const grant = f.grant({ maxPerDay: 1 });
  await f.apply.autoApply(first.id, grant.id as string);
  await expect(f.apply.autoApply(second.id, grant.id as string)).rejects.toThrow(
    "daily learning limit",
  );
  expect(f.proposals[1]?.status).toBe("pending");
  expect(f.memoryDb.documents.size).toBe(1);
});
it("revocation between a queued lookup and apply stops the write", async () => {
  const f = fixture(),
    proposal = await f.proposal(),
    grant = f.grant();
  f.db.learningGrant.findUnique.mockImplementationOnce(async () => {
    const queued = { ...grant };
    grant.revokedAt = new Date();
    return queued;
  });
  await expect(f.apply.autoApply(proposal.id, grant.id as string)).rejects.toThrow();
  expect(f.memoryDb.documents.size).toBe(0);
});
it("serializes simultaneous approvals so only one revision and audit are created", async () => {
  const f = fixture(),
    proposal = await f.proposal();
  const results = await Promise.allSettled([
    f.apply.approve(proposal.id, actor),
    f.apply.approve(proposal.id, actor),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(f.memoryDb.revisions).toHaveLength(1);
  expect(f.audits).toHaveLength(1);
});

it("keeps user-scope grants distinct from bot-scope approvals and grants", async () => {
  const f = fixture(),
    grants = createLearningGrants(f.deps.prisma);
  for (let i = 0; i < 5; i++) {
    const proposal = await f.proposal();
    await f.apply.approve(proposal.id, actor);
  }
  await expect(
    grants.create(actor, { category: "memory", scope: { kind: "user" }, limits: { maxPerDay: 5 } }),
  ).rejects.toThrow();
  const proposal = await f.proposal(undefined, { scope: actor });
  const botGrant = f.grant();
  await expect(f.apply.autoApply(proposal.id, botGrant.id as string)).rejects.toThrow();
  const userGrant = f.grant({ scope: { kind: "user" }, scopeKey: "user" });
  const result = await f.apply.autoApply(proposal.id, userGrant.id as string);
  expect((await f.service.read(result.proposal.documentId!, f.context))?.scopeKey.kind).toBe(
    "user",
  );
});
it("returns a conflict when later work tombstoned the applied document", async () => {
  const f = fixture(),
    proposal = await f.proposal("Before");
  await f.apply.approve(proposal.id, actor);
  await f.service.delete(proposal.target.documentId!, 2, f.context);
  const result = await f.apply.revert(proposal.id, actor);
  expect(result.conflict).toMatchObject({ current: "", expectedRevision: 3 });
  expect((await f.service.read(proposal.target.documentId!, f.context))?.revision).toBe(3);
});

it("shows the actual visible setting when an intervening preference edit conflicts with undo", async () => {
  const f = fixture(),
    proposal = await f.proposal(undefined, {
      type: "preference",
      proposedContent: undefined,
      typedDelta: { key: "bot.autoSpeak", value: true },
      settingBefore: false,
    });
  await f.apply.approve(proposal.id, actor);
  f.bot.autoSpeak = false;
  const result = await f.apply.revert(proposal.id, actor);
  expect(JSON.parse(result.conflict!.current)).toEqual({ key: "bot.autoSpeak", value: false });
  expect(f.bot.autoSpeak).toBe(false);
});

it("applies a read policy only by human approval and stores the exact bot scope", async () => {
  const f = fixture();
  const p = await f.proposal(undefined, {
    type: "policy-suggestion",
    policyTool: "GMAIL_LIST_MESSAGES",
    proposedContent: undefined,
    typedDelta: { key: "approval.tool", value: "GMAIL_LIST_MESSAGES" },
  });
  await expect(f.apply.autoApply(p.id, f.grant().id as string)).rejects.toThrow();
  expect(f.db.actionApprovalRule.upsert).not.toHaveBeenCalled();
  const result = await f.apply.approve(p.id, actor);
  expect(result.proposal.status).toBe("applied");
  expect(result.proposal.policyRuleId).toBe("rule");
  expect(f.db.actionApprovalRule.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        botId: "bot",
        scopeKey: "bot:bot",
        effect: "always_allow",
        matchKind: "tool",
        matchValue: "GMAIL_LIST_MESSAGES",
      }),
    }),
  );
  expect(f.memoryDb.revisions).toHaveLength(0);
});
it("refuses consequential policy suggestions even on the manual apply path", async () => {
  const f = fixture();
  const p = await f.proposal(undefined, {
    type: "policy-suggestion",
    policyTool: "GMAIL_SEND_EMAIL",
    proposedContent: undefined,
    typedDelta: { key: "approval.tool", value: "GMAIL_SEND_EMAIL" },
  });
  await expect(f.apply.approve(p.id, actor)).rejects.toThrow();
  expect(f.db.actionApprovalRule.upsert).not.toHaveBeenCalled();
});
it("rejecting a policy suggestion suppresses it for thirty days without writing an approval rule", async () => {
  const f = fixture();
  const p = await f.proposal(undefined, {
    type: "policy-suggestion",
    policyTool: "GMAIL_LIST_MESSAGES",
    proposedContent: undefined,
    typedDelta: { key: "approval.tool", value: "GMAIL_LIST_MESSAGES" },
  });
  f.suppressions.push({
    ...actor,
    fingerprint: proposalFingerprint(p),
    createdAt: new Date("2020-01-01Z"),
  });
  await f.apply.reject(p.id, actor);
  expect(f.db.actionApprovalRule.upsert).not.toHaveBeenCalled();
  const rejectedAt = f.suppressions[0]!.createdAt as Date;
  expect(rejectedAt.getTime()).toBeGreaterThan(new Date("2020-01-01Z").getTime());
  expect(policySuppressed(rejectedAt, new Date(rejectedAt.getTime() + 29 * 86400000))).toBe(true);
  expect(policySuppressed(rejectedAt, new Date(rejectedAt.getTime() + 30 * 86400000))).toBe(false);
});
it("requires human approval for curator reverts and shares Undo's revision path", async () => {
  const f = fixture();
  const original = await f.proposal("Original instruction.");
  const applied = (await f.apply.approve(original.id, actor)).proposal;
  const suggestion = await f.proposal(undefined, {
    operation: "revert-suggestion",
    revertsProposalId: original.id,
    target: { documentId: applied.documentId },
    proposedContent: "",
    observation: { revisionId: applied.appliedRevisionId } as never,
  });
  // Stored observations are validated contracts, not arbitrary rationale text.
  const row = f.proposals.find((r) => r.id === suggestion.id)!;
  (row.body as LearningProposal).observation = projectLearningObservation({
    documentId: applied.documentId!,
    revisionId: applied.appliedRevisionId!,
    createdAt: new Date(),
    now: new Date(),
    runs: [],
    exposures: [],
  });
  await expect(f.apply.autoApply(suggestion.id, f.grant().id as string)).rejects.toThrow();
  expect((await f.service.read(applied.documentId!, f.context))!.content).toBe(
    "Use numbered steps.",
  );
  expect((await f.apply.approve(suggestion.id, actor)).proposal.status).toBe("reverted");
  expect((await f.service.read(applied.documentId!, f.context))!.content).toBe(
    "Original instruction.",
  );
  expect(f.proposals.find((r) => r.id === original.id)!.status).toBe("reverted");
});

it.each(["memory-import", "memory-edit"] as const)(
  "never automatically applies %s, even with a matching grant",
  async (operation) => {
    const f = fixture();
    const p = await f.proposal(undefined, { operation });
    const grant = f.grant();
    await expect(f.apply.autoApply(p.id, String(grant.id))).rejects.toThrow("no longer allowed");
    expect(f.memoryDb.documents.size).toBe(0);
  },
);
it("approves a user import with its kind and requires approval before deleting and undoing it", async () => {
  const f = fixture();
  f.db.reviewExecution.findFirst.mockResolvedValue({
    reviewerPin: pin,
    policyVersion: "memory-settings-v1",
    userId: actor.userId,
    botId: "bot",
    completedAt: new Date(),
  } as never);
  f.db.run.findFirst.mockResolvedValue(null as never);
  const p = await f.proposal(undefined, {
    scope: actor,
    operation: "memory-import",
    documentKind: "profile",
    proposedContent: "Studies plants.",
  });
  expect(f.memoryDb.documents.size).toBe(0);
  const saved = await f.apply.approve(p.id, actor);
  const head = await f.service.read(saved.proposal.documentId!, f.context);
  expect(head).toMatchObject({ kind: "profile", content: "Studies plants." });
  expect(parseRevisionMarkdown(revisionMarkdown(head!)).kind).toBe("profile");
  const removal = await f.proposal(undefined, {
    scope: actor,
    operation: "memory-edit",
    memoryAction: "delete",
    documentKind: "profile",
    target: { documentId: head!.id },
    expectedBaseRevision: head!.revision,
    proposedContent: "",
  });
  expect((await f.service.read(head!.id, f.context))?.deletedAt).toBeNull();
  await f.apply.approve(removal.id, actor);
  expect((await f.service.read(head!.id, f.context))?.deletedAt).not.toBeNull();
  await f.apply.revert(removal.id, actor);
  expect(await f.service.read(head!.id, f.context)).toMatchObject({
    kind: "profile",
    content: "Studies plants.",
    deletedAt: null,
    revision: 3,
  });
});

it.each([undefined, "profile"] as const)(
  "preserves citations when applying a proposal with category %s",
  async (documentKind) => {
    const f = fixture();
    const references = ["https://sources.example.test/original"];
    const head = await f.service.commit(
      {
        scope: "bot",
        path: "notes/cited.md",
        content: "Use paragraphs.",
        kind: "topic",
        references,
        expectedRevision: 0,
      },
      f.context,
    );
    const proposal = await f.proposal(undefined, {
      target: { documentId: head.id },
      expectedBaseRevision: head.revision,
      documentKind,
    });
    await f.apply.approve(proposal.id, actor);
    expect(await f.service.read(head.id, f.context)).toMatchObject({
      content: "Use numbered steps.",
      references,
      kind: documentKind ?? "topic",
    });
    expect(
      (await f.service.exportBundle(f.context)).documents[0]?.revisions.at(-1)?.references,
    ).toEqual(references);
  },
);

it("preserves current citations when undoing a category change", async () => {
  const f = fixture();
  const p = await f.proposal("Use paragraphs.", { documentKind: "profile" });
  await f.apply.approve(p.id, actor);
  const head = (await f.service.read(p.target.documentId!, f.context))!;
  const references = ["https://sources.example.test/later"];
  await f.service.commit(
    {
      id: head.id,
      scope: "bot",
      path: head.path,
      content: head.content,
      kind: head.kind,
      references,
      expectedRevision: head.revision,
    },
    f.context,
  );
  await f.apply.revert(p.id, actor);
  expect(await f.service.read(head.id, f.context)).toMatchObject({
    content: "Use paragraphs.",
    kind: "topic",
    references,
  });
});

function boardFixture(filed: { duplicate: boolean; updatedAt?: string }) {
  const f = fixture();
  const item = {
    id: "board-a",
    status: "open",
    updatedAt: filed.updatedAt ?? "2026-09-25T12:00:00.000Z",
  };
  const hostCalls: Array<{ call: string; transactions: number }> = [];
  const host = (call: string) => hostCalls.push({ call, transactions: f.transactions.open });
  const close = vi.fn(async () => {
    host("close");
    return [{ ...item, status: "closed" }];
  });
  const show = vi.fn(async () => {
    host("show");
    return item;
  });
  const boardService = {
    withFilingLock: vi.fn(async (_scope: unknown, work: () => Promise<unknown>) => work()),
    fileLearningProposal: vi.fn(async (_scope: unknown, proposalId: string) => {
      host("file");
      f.filings.push({
        id: `filing-${f.filings.length}`,
        ...actor,
        botId: "bot",
        workspaceId: "workspace",
        itemId: "board-a",
        learningProposalId: proposalId,
        reused: filed.duplicate,
      });
      return {
        workspaceId: "workspace",
        duplicate: filed.duplicate,
        item: { ...item, updatedAt: "2026-09-25T12:00:00.000Z" },
      };
    }),
    provider: vi.fn(async () => ({ show, close })),
  };
  const apply = createLearningApplyService({ ...f.deps, boardService: boardService as never });
  const proposal = () =>
    f.proposal(undefined, {
      type: "board-item",
      proposedContent: undefined,
      boardItem: {
        title: "Finish the import follow-up",
        description: "The run stopped before the import finished.",
        acceptanceCriteria: "The import completes.",
      },
    });
  return { f, apply, boardService, close, show, hostCalls, proposal };
}

it.each([false, true])(
  "undoes an unchanged board item and leaves a changed item alone (changed=%s)",
  async (changed) => {
    const {
      f,
      apply,
      boardService,
      close,
      hostCalls,
      proposal: create,
    } = boardFixture({
      duplicate: false,
      updatedAt: changed ? "2026-09-25T13:00:00.000Z" : undefined,
    });
    const proposal = await create();
    await expect(apply.autoApply(proposal.id, f.grant().id as string)).rejects.toThrow();
    expect(boardService.fileLearningProposal).not.toHaveBeenCalled();
    const applied = await apply.approve(proposal.id, actor);
    expect(applied.proposal).toMatchObject({
      status: "applied",
      appliedBoardItem: { workspaceId: "workspace", itemId: "board-a", duplicate: false },
    });
    const undone = await apply.revert(proposal.id, actor);
    if (changed) {
      expect(close).not.toHaveBeenCalled();
      expect(undone.conflict?.current).toBe(
        "This board item changed after it was filed. Review it on the Board.",
      );
    } else {
      expect(close).toHaveBeenCalledWith(["board-a"], "Undone from Learning");
      expect(undone.proposal.status).toBe("reverted");
    }
    expect(hostCalls.map((call) => call.call)).toEqual(
      changed ? ["file", "show"] : ["file", "show", "close"],
    );
    expect(hostCalls.every((call) => call.transactions === 0)).toBe(true);
    expect(boardService.withFilingLock).toHaveBeenCalledTimes(2);
  },
);

it("undoes a reused, human-created board item by removing only the association", async () => {
  const { f, apply, close, show, proposal: create } = boardFixture({ duplicate: true });
  const proposal = await create();
  f.filings.push({
    id: "human",
    ...actor,
    botId: null,
    workspaceId: "workspace",
    itemId: "board-a",
    learningProposalId: null,
    reused: false,
  });
  const applied = await apply.approve(proposal.id, actor);
  expect(applied.proposal.appliedBoardItem).toMatchObject({ itemId: "board-a", duplicate: true });
  const undone = await apply.revert(proposal.id, actor);
  expect(undone.conflict).toBeUndefined();
  expect(undone.proposal.status).toBe("reverted");
  expect(close).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
  expect(f.filings.map((row) => row.id)).toEqual(["human"]);
  expect(f.audits.map((row) => row.action)).toEqual(["approve", "revert"]);
});

it("does not file a board item for a proposal rejected while approval waited", async () => {
  const { f, apply, boardService, proposal: create } = boardFixture({ duplicate: false });
  const proposal = await create();
  boardService.withFilingLock.mockImplementationOnce(async (_scope, work) => {
    await apply.reject(proposal.id, actor);
    return work();
  });
  await expect(apply.approve(proposal.id, actor)).rejects.toThrow(
    "This suggestion is no longer pending.",
  );
  expect(boardService.fileLearningProposal).not.toHaveBeenCalled();
  expect(f.proposals[0]).toMatchObject({ status: "rejected" });
});

it("undoes an approved category edit without overwriting later category changes", async () => {
  const f = fixture();
  f.db.reviewExecution.findFirst.mockResolvedValue({
    reviewerPin: pin,
    policyVersion: "memory-settings-v1",
    userId: actor.userId,
    botId: "bot",
    completedAt: new Date(),
  } as never);
  const imported = await f.proposal(undefined, {
    scope: actor,
    operation: "memory-import",
    documentKind: "profile",
    proposedContent: "Studies plants.",
  });
  const saved = (await f.apply.approve(imported.id, actor)).proposal;
  const edit = await f.proposal(undefined, {
    scope: actor,
    operation: "memory-edit",
    documentKind: "topic",
    target: { documentId: saved.documentId },
    expectedBaseRevision: 1,
    proposedContent: "Garden planning.",
  });
  await f.apply.approve(edit.id, actor);
  expect((await f.service.read(saved.documentId!, f.context))?.kind).toBe("topic");
  const head = (await f.service.read(saved.documentId!, f.context))!;
  await f.service.commit(
    {
      id: head.id,
      scope: "user",
      path: head.path,
      content: head.content,
      kind: "preferences",
      expectedRevision: head.revision,
    },
    f.context,
  );
  expect((await f.apply.revert(edit.id, actor)).conflict).toBeDefined();
  const later = (await f.service.read(head.id, f.context))!;
  await f.service.commit(
    {
      id: head.id,
      scope: "user",
      path: head.path,
      content: later.content,
      kind: "topic",
      expectedRevision: later.revision,
    },
    f.context,
  );
  await f.apply.revert(edit.id, actor);
  expect(await f.service.read(head.id, f.context)).toMatchObject({
    kind: "profile",
    content: "Studies plants.",
  });
});
