import type { LearningProposal, RuntimePin } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { MemoryService, PostgresDocumentStore } from "@ardurbot/memory";
import { memoryDatabaseFake, serialMemoryLock } from "@ardurbot/testkit/memory-fakes";
import { describe, expect, it, vi } from "vitest";
import { createLearningApplyService } from "./learning-apply.js";
import { applyGrantedLearning } from "./learning-auto-apply.js";
import { createLearningGrants } from "./learning-grants.js";
import { inverseLearningChange } from "./learning-inverse.js";
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
  };
}
function fixture() {
  const proposals: Row[] = [],
    audits: Row[] = [],
    grants: Row[] = [],
    suppressions: Row[] = [],
    skills: Row[] = [];
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
        const collections = [proposals, audits, grants, suppressions, skills];
        const snapshot = collections.map((rows) => structuredClone(rows));
        const docs = structuredClone(memoryDb.documents),
          revisions = structuredClone(memoryDb.revisions);
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
