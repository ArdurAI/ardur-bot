import type { Actor, LearningGrantInput, LearningProposal } from "@ardurbot/contracts";
import { LearningGrantInputSchema, LearningGrantSchema } from "@ardurbot/contracts";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { proposalFingerprint } from "./learning-proposal.js";
import { lockMemorySpace } from "./memory/lifecycle.js";

type Identity = Pick<Actor, "spaceId" | "userId">;
export function learningScopeKey(scope: LearningGrantInput["scope"]) {
  return scope.kind === "bot" ? `bot:${scope.botId}` : "user";
}
export function proposalScope(proposal: LearningProposal): LearningGrantInput["scope"] {
  return proposal.scope.botId ? { kind: "bot", botId: proposal.scope.botId } : { kind: "user" };
}
export async function learningMember(
  tx: Prisma.TransactionClient,
  actor: Identity,
  botId?: string,
) {
  const member = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
  });
  if (!member) throw new IsolationError();
  if (botId && !(await tx.bot.findFirst({ where: { id: botId, ...actor } })))
    throw new IsolationError();
  return member;
}
export async function matchingLearningGrant(
  tx: Prisma.TransactionClient,
  actor: Identity,
  proposal: LearningProposal,
  now = new Date(),
) {
  if (!proposal.scope.userId || !["memory", "skill"].includes(proposal.type)) return null;
  const suppressed = await tx.learningSuppression.findUnique({
    where: {
      spaceId_userId_fingerprint: {
        ...actor,
        fingerprint: proposalFingerprint(proposal),
      },
    },
  });
  if (suppressed) return null;
  return tx.learningGrant.findFirst({
    where: {
      ...actor,
      category: proposal.type,
      scopeKey: learningScopeKey(proposalScope(proposal)),
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
  });
}
function grantView(row: {
  id: string;
  spaceId: string;
  userId: string;
  category: string;
  scope: unknown;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  maxPerDay: number;
}) {
  return LearningGrantSchema.parse({
    id: row.id,
    spaceId: row.spaceId,
    userId: row.userId,
    category: row.category,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    limits: { maxPerDay: row.maxPerDay },
  });
}
export function createLearningGrants(prisma: PrismaClient) {
  async function list(actor: Identity) {
    await learningMember(prisma, actor);
    const [grants, approvals, declined] = await Promise.all([
      prisma.learningGrant.findMany({ where: actor, orderBy: { createdAt: "desc" } }),
      prisma.learningAudit.findMany({ where: { ...actor, action: "approve", grantId: null } }),
      prisma.learningAudit.findMany({ where: { ...actor, action: "grant-declined" } }),
    ]);
    const counts = new Map<
      string,
      {
        category: "memory" | "skill";
        scope: LearningGrantInput["scope"];
        count: number;
        lastApprovalAt: Date;
      }
    >();
    for (const row of approvals) {
      if (!row.scopeKey || (row.category !== "memory" && row.category !== "skill")) continue;
      const key = `${row.category}:${row.scopeKey}`;
      const value = counts.get(key) ?? {
        category: row.category,
        scope: row.scopeKey.startsWith("bot:")
          ? { kind: "bot" as const, botId: row.scopeKey.slice(4) }
          : { kind: "user" as const },
        count: 0,
        lastApprovalAt: new Date(0),
      };
      value.count++;
      if (row.createdAt > value.lastApprovalAt) value.lastApprovalAt = row.createdAt;
      counts.set(key, value);
    }
    return {
      grants: grants.map(grantView),
      offers: [...counts.values()]
        .filter(
          (item) =>
            item.count >= 5 &&
            !grants.some(
              (g) =>
                g.category === item.category &&
                g.scopeKey === learningScopeKey(item.scope) &&
                !g.revokedAt &&
                (!g.expiresAt || g.expiresAt > new Date()),
            ) &&
            !declined.some(
              (g) =>
                g.category === item.category &&
                g.scopeKey === learningScopeKey(item.scope) &&
                g.createdAt >= item.lastApprovalAt,
            ),
        )
        .map(({ category, scope }) => ({ category, scope })),
    };
  }
  return {
    list,
    async create(actor: Identity, value: LearningGrantInput) {
      const input = LearningGrantInputSchema.parse(value);
      return prisma.$transaction(async (tx) => {
        await lockMemorySpace(tx, actor.spaceId);
        await learningMember(tx, actor, input.scope.kind === "bot" ? input.scope.botId : undefined);
        const scopeKey = learningScopeKey(input.scope);
        const existing = await tx.learningGrant.findFirst({
          where: {
            ...actor,
            category: input.category,
            scopeKey,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        });
        if (existing) return grantView(existing);
        const count = await tx.learningAudit.count({
          where: { ...actor, action: "approve", grantId: null, category: input.category, scopeKey },
        });
        if (count < 5)
          throw new Error("Approve five suggestions in this category and scope first.");
        if (input.expiresAt && new Date(input.expiresAt) <= new Date())
          throw new Error("Choose a future expiry.");
        const row = await tx.learningGrant.create({
          data: {
            ...actor,
            category: input.category,
            scope: input.scope,
            scopeKey,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            maxPerDay: input.limits.maxPerDay,
          },
        });
        await tx.learningAudit.create({
          data: {
            ...actor,
            action: "grant-created",
            grantId: row.id,
            category: input.category,
            scopeKey,
          },
        });
        return grantView(row);
      });
    },
    async revoke(actor: Identity, id: string) {
      await prisma.$transaction(async (tx) => {
        await lockMemorySpace(tx, actor.spaceId);
        await learningMember(tx, actor);
        const grant = await tx.learningGrant.findFirst({ where: { id, ...actor } });
        if (!grant) throw new IsolationError();
        await tx.learningGrant.update({ where: { id }, data: { revokedAt: new Date() } });
        await tx.learningAudit.create({ data: { ...actor, action: "grant-revoked", grantId: id } });
      });
      return { ok: true as const };
    },
    async decline(actor: Identity, input: Pick<LearningGrantInput, "category" | "scope">) {
      await learningMember(
        prisma,
        actor,
        input.scope.kind === "bot" ? input.scope.botId : undefined,
      );
      await prisma.learningAudit.create({
        data: {
          ...actor,
          action: "grant-declined",
          category: input.category,
          scopeKey: learningScopeKey(input.scope),
        },
      });
      return { ok: true as const };
    },
  };
}
