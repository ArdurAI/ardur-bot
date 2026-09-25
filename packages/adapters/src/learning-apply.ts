import type {
  Actor,
  LearningEdit,
  LearningProposal,
  MemoryDocumentHead,
} from "@ardurbot/contracts";
import {
  LearningEditSchema,
  LearningProposalSchema,
  learningApprovalBlock,
  MEMORY_INTENT_POLICY,
  RuntimePinSchema,
} from "@ardurbot/contracts";
import { isReadPolicyTool, parseSkillMd, redactLearningText } from "@ardurbot/core";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import type { MemoryOperationContext, MemoryService } from "@ardurbot/memory";
import type { BoardService } from "./board/service.js";
import {
  learningMember,
  learningScopeKey,
  matchingLearningGrant,
  proposalScope,
} from "./learning-grants.js";
import { inverseLearningChange } from "./learning-inverse.js";
import { proposalDiff, proposalFingerprint } from "./learning-proposal.js";
import { learningSecrets } from "./learning-redaction.js";
import { lockMemorySpace } from "./memory/lifecycle.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { skillDocumentContext } from "./skill-documents.js";

type Identity = Pick<Actor, "spaceId" | "userId">;
const BOARD_UNDO_REASON = "Undone from Learning";
const BOARD_REJECT_REASON = "Rejected from Learning";
const BOARD_ITEM_CHANGED = "This board item changed after it was filed. Review it on the Board.";
const BOARD_REJECT_LEFT =
  "This board item changed after it was filed, so it was left open for review on the Board.";
type LearningActionResult = {
  proposal: LearningProposal;
  conflict?: {
    before: string;
    applied: string;
    current: string;
    expectedRevision: number;
  };
};
export interface LearningApplyDependencies {
  prisma: PrismaClient;
  memoryDocuments?: MemoryService;
  secretStore: EncryptedSecretStore;
  boardService?: BoardService;
}
export function proposalView(row: {
  body: unknown;
  status: string;
  appliedRevisionId?: string | null;
  revertedRevisionId?: string | null;
  appliedAt?: Date | null;
}) {
  const { evidenceWatermark: _watermark, ...body } = row.body as Record<string, unknown>;
  return LearningProposalSchema.parse({
    ...body,
    status: row.status,
    appliedRevisionId: row.appliedRevisionId ?? undefined,
    revertedRevisionId: row.revertedRevisionId ?? undefined,
    appliedAt: row.appliedAt?.toISOString(),
  });
}
export function createLearningApplyService(deps: LearningApplyDependencies) {
  const memory = () => {
    if (!deps.memoryDocuments) throw new Error("Document storage is unavailable.");
    return deps.memoryDocuments;
  };
  async function operation<T>(
    id: string,
    actor: Identity,
    action: (
      tx: Prisma.TransactionClient,
      proposal: LearningProposal,
      context: MemoryOperationContext,
      audit: (
        action: string,
        before?: string,
        after?: string,
        grantId?: string,
      ) => Promise<unknown>,
    ) => Promise<T>,
  ) {
    return deps.prisma.$transaction(
      async (tx) => {
        await lockMemorySpace(tx, actor.spaceId);
        const row = await tx.learningProposal.findFirst({ where: { id, ...actor } });
        if (!row) throw new IsolationError();
        await learningMember(tx, actor, row.botId);
        // Uses the same thread row lock as clear/delete; queued grants cannot outlive source history.
        const source = await tx.thread.updateMany({
          where: {
            id: row.threadId,
            spaceId: actor.spaceId,
            historyCompactionGeneration: row.historyGeneration,
          },
          data: { historyCompactionGeneration: row.historyGeneration },
        });
        if (source.count !== 1) throw new IsolationError();
        const proposal = proposalView(row);
        if (
          proposal.scope.spaceId !== actor.spaceId ||
          (proposal.scope.userId && proposal.scope.userId !== actor.userId) ||
          (proposal.scope.botId && proposal.scope.botId !== row.botId)
        )
          throw new IsolationError();
        const knownSecrets = await learningSecrets(deps.prisma, deps.secretStore, row);
        const context: MemoryOperationContext = {
          ...skillDocumentContext({
            ...actor,
            botId: row.botId,
            runId: row.runId,
            threadId: row.threadId,
          }),
          knownSecrets,
          databaseTransaction: tx,
        };
        const audit = (
          action: string,
          beforeRevisionId?: string,
          afterRevisionId?: string,
          grantId?: string,
        ) =>
          tx.learningAudit.create({
            data: {
              ...actor,
              proposalId: id,
              action,
              category: proposal.type,
              scopeKey: learningScopeKey(proposalScope(proposal)),
              beforeRevisionId,
              afterRevisionId,
              grantId,
            },
          });
        return action(tx, proposal, context, audit);
      },
      { timeout: 60_000 },
    );
  }
  async function save(
    tx: Prisma.TransactionClient,
    proposal: LearningProposal,
    extra: Record<string, unknown> = {},
  ) {
    const row = await tx.learningProposal.update({
      where: { id: proposal.id },
      data: {
        body: proposal as Prisma.InputJsonValue,
        status: proposal.status,
        ...extra,
      },
    });
    return proposalView(row);
  }
  async function target(
    tx: Prisma.TransactionClient,
    proposal: LearningProposal,
    context: MemoryOperationContext,
    id = proposal.target.documentId,
    allowDeleted = false,
  ) {
    if (!id) return null;
    const head = await memory().read(id, context);
    if (
      !head ||
      (!allowDeleted && head.deletedAt) ||
      head.scopeKey.kind === "space-shared" ||
      head.scopeKey.userId !== context.userId ||
      (head.scopeKey.kind === "bot"
        ? head.scopeKey.botId !== proposal.scope.botId
        : !!proposal.scope.botId)
    )
      throw new IsolationError();
    if (proposal.operation?.startsWith("memory-") && /^(skills|preferences)\//.test(head.path))
      throw new IsolationError();
    if (head.path.startsWith("skills/")) {
      const skill = await tx.agentSkill.findFirst({
        where: { documentId: id, spaceId: context.spaceId, userId: context.userId },
      });
      if (
        !skill ||
        skill.protected ||
        !["user", "learned"].includes(skill.source) ||
        !["user", "learned"].includes(skill.origin) ||
        skill.botId !== (proposal.scope.botId ?? null)
      )
        throw new Error("Protected and repository skills cannot be changed here.");
      if (proposal.type !== "skill") throw new IsolationError();
    } else if (proposal.type === "skill") throw new IsolationError();
    return head;
  }
  async function editContent(
    tx: Prisma.TransactionClient,
    proposal: LearningProposal,
    context: MemoryOperationContext,
    edits: LearningEdit,
    head: MemoryDocumentHead | null,
  ) {
    const input = LearningEditSchema.parse(edits);
    if (proposal.type === "preference") {
      if (!input.typedDelta || input.typedDelta.key !== proposal.typedDelta?.key)
        throw new Error("Edit the suggested setting value only.");
      proposal.typedDelta = input.typedDelta;
    } else {
      if (input.proposedContent === undefined) throw new Error("Provide document content.");
      proposal.proposedContent = redactLearningText(input.proposedContent, context.knownSecrets);
    }
    validateContent(proposal);
    proposal.diff = proposalDiff(
      redactLearningText(
        head?.content ?? JSON.stringify(proposal.settingBefore) ?? "",
        context.knownSecrets,
      ),
      proposal.proposedContent ?? JSON.stringify(proposal.typedDelta),
    );
    await tx.learningProposal.update({
      where: { id: proposal.id },
      data: { body: proposal as Prisma.InputJsonValue },
    });
  }
  function validateContent(proposal: LearningProposal) {
    if (
      proposal.type === "skill" &&
      (!proposal.proposedContent ||
        "error" in parseSkillMd(proposal.proposedContent) ||
        /```|~~~/.test(proposal.proposedContent))
    )
      throw new Error("Use a prose skill with name and description frontmatter.");
    if (proposal.memoryAction === "delete") {
      if (
        proposal.type !== "memory" ||
        proposal.operation !== "memory-edit" ||
        !proposal.target.documentId ||
        proposal.proposedContent !== ""
      )
        throw new Error("Invalid memory removal.");
      return;
    }
    if (["memory", "skill"].includes(proposal.type) && !proposal.proposedContent?.trim())
      throw new Error("Provide document content.");
  }
  async function attribution(
    tx: Prisma.TransactionClient,
    proposal: LearningProposal,
    context: MemoryOperationContext,
    parentRevision: number,
    action: "apply" | "revert",
    grantId?: string,
  ) {
    const run = await tx.run.findFirst({
      where: { id: context.runId, spaceId: context.spaceId, userId: context.userId },
    });
    const review = await tx.reviewExecution.findFirst({
      where: {
        runId: context.runId,
        spaceId: context.spaceId,
        proposalIds: { array_contains: [proposal.id] },
      },
    });
    const manual = ["memory-import", "memory-edit"].includes(proposal.operation ?? "");
    if (
      !review ||
      (manual
        ? review.policyVersion !== MEMORY_INTENT_POLICY ||
          review.userId !== context.userId ||
          review.botId !== context.botId ||
          !review.completedAt
        : !run)
    )
      throw new IsolationError();
    const reviewerPin = RuntimePinSchema.parse(review.reviewerPin);
    context.learning = {
      proposalId: proposal.id,
      approvingUserId: context.userId,
      grantId,
      originatingPin: run?.runtimePin
        ? RuntimePinSchema.parse(run.runtimePin)
        : manual
          ? (proposal.provenance?.originatingPin ?? null)
          : null,
      reviewerPin,
      policyVersion: review.policyVersion,
      action,
      parentRevision,
    };
    context.memoryModel =
      reviewerPin.provider && reviewerPin.modelId
        ? {
            provider: reviewerPin.provider,
            modelId: reviewerPin.modelId,
            effort: reviewerPin.effort ?? null,
          }
        : undefined;
    proposal.provenance = {
      runId: context.runId!,
      originatingPin: context.learning.originatingPin,
      reviewerPin,
      policyVersion: review.policyVersion,
    };
  }
  async function revertChange(
    tx: Prisma.TransactionClient,
    proposal: LearningProposal,
    context: MemoryOperationContext,
    audit: (action: string, before?: string, after?: string, grantId?: string) => Promise<unknown>,
    onCommit: (doc: MemoryDocumentHead, context: MemoryOperationContext) => void,
  ) {
    const actor = { spaceId: context.spaceId, userId: context.userId };
    if (proposal.status !== "applied" || !proposal.documentId || !proposal.appliedRevisionId)
      throw new Error("This suggestion has no applied change to undo.");
    const head = await target(tx, proposal, context, proposal.documentId, true);
    if (!head) throw new IsolationError();
    const revision = Number(proposal.appliedRevisionId.split(":").at(-1));
    const history = await memory().history(head.id, { cursor: revision + 1, limit: 2 }, context);
    const applied = history.items.find((item) => item.revision === revision);
    const parent = history.items.find((item) => item.revision === revision - 1);
    if (!applied || (revision > 1 && !parent)) throw new IsolationError();
    const kindChanged = (parent?.kind ?? "topic") !== (applied.kind ?? "topic");
    const kindConflict = kindChanged && (head.kind ?? "topic") !== (applied.kind ?? "topic");
    const inverse = head.deletedAt
      ? proposal.memoryAction === "delete" && head.revision === revision
        ? (parent?.content ?? null)
        : null
      : revision === 1
        ? head.revision === revision
          ? ""
          : null
        : inverseLearningChange(parent!.content, applied.content, head.content);
    let settingConflict = false;
    let conflictBefore = parent?.content ?? "";
    let conflictCurrent = head.content;
    if (proposal.type === "preference") {
      const key =
        proposal.typedDelta!.key === "bot.notifyOnFinish" ? "notifyOnFinish" : "autoSpeak";
      const bot = await tx.bot.findFirst({ where: { id: proposal.scope.botId, ...actor } });
      if (!bot) throw new IsolationError();
      conflictBefore = JSON.stringify({
        key: proposal.typedDelta!.key,
        value: proposal.settingBefore,
      });
      conflictCurrent = JSON.stringify({ key: proposal.typedDelta!.key, value: bot[key] });
      settingConflict = bot[key] !== proposal.typedDelta!.value;
      if (!settingConflict && inverse !== null) {
        const changed = await tx.bot.updateMany({
          where: { id: bot!.id, ...actor, [key]: proposal.typedDelta!.value },
          data: { [key]: proposal.settingBefore },
        });
        settingConflict = changed.count !== 1;
      }
    }
    if (inverse === null || settingConflict || kindConflict) {
      await audit("revert-conflict", proposal.appliedRevisionId, `${head.id}:${head.revision}`);
      return {
        proposal,
        conflict: {
          before: redactLearningText(conflictBefore, context.knownSecrets),
          applied: redactLearningText(applied.content, context.knownSecrets),
          current: redactLearningText(conflictCurrent, context.knownSecrets),
          expectedRevision: head.revision,
        },
      };
    }
    await attribution(tx, proposal, context, head.revision, "revert");
    const doc =
      head.deletedAt && parent
        ? await memory().restore(head.id, parent.revision, head.revision, context)
        : revision === 1
          ? await memory().delete(head.id, head.revision, context)
          : kindChanged && parent
            ? await memory().commit(
                {
                  id: head.id,
                  scope: head.scopeKey.kind,
                  botId: proposal.scope.botId,
                  path: head.path,
                  kind: parent.kind ?? "topic",
                  content: inverse,
                  references: head.references,
                  expectedRevision: head.revision,
                },
                context,
              )
            : await memory().update(head.id, inverse, head.revision, context);
    if (proposal.type === "skill") {
      const metadata = doc.deletedAt ? null : parseSkillMd(doc.content);
      if (metadata && "error" in metadata) throw new Error("Review this skill before undoing it.");
      await tx.agentSkill.updateMany({
        where: { documentId: doc.id, ...actor },
        data: {
          activeRevision: doc.revision,
          ...(metadata ? { name: metadata.name, description: metadata.description } : {}),
        },
      });
    }
    proposal.status = "reverted";
    await audit("revert", `${head.id}:${head.revision}`, `${doc.id}:${doc.revision}`);
    const saved = await save(tx, proposal, { revertedRevisionId: `${doc.id}:${doc.revision}` });
    onCommit(doc, context);
    return { proposal: saved };
  }
  async function proposalStatus(id: string, actor: Identity) {
    const row = await deps.prisma.learningProposal.findFirst({
      where: { id, ...actor },
      select: { status: true },
    });
    if (!row) throw new IsolationError();
    return row.status;
  }
  /** Files outside the learning transaction; the filing lock also orders reject and Undo. */
  async function fileBoardItem(
    id: string,
    actor: Identity,
    proposal: LearningProposal,
    secrets: string[],
  ) {
    const service = deps.boardService!;
    return service.withFilingLock(actor, async () => {
      if ((await proposalStatus(id, actor)) !== "pending")
        throw new Error("This suggestion is no longer pending.");
      const filed = await service.fileLearningProposal(
        { ...actor, botId: proposal.scope.botId! },
        proposal.id,
        proposal.boardItem!,
        secrets,
      );
      return operation(id, actor, async (tx, current, _context, audit) => {
        if (current.status !== "pending") throw new Error("This suggestion is no longer pending.");
        current.appliedBoardItem = {
          workspaceId: filed.workspaceId,
          itemId: filed.item.id,
          updatedAt: filed.item.updatedAt,
          duplicate: filed.duplicate,
        };
        current.status = "applied";
        await audit("approve");
        return { proposal: await save(tx, current, { appliedAt: new Date() }) };
      });
    });
  }
  /** Closes the filed item only if nobody changed it since approval. */
  async function undoBoardItem(id: string, actor: Identity, proposal: LearningProposal) {
    const service = deps.boardService!;
    const applied = proposal.appliedBoardItem!;
    return service.withFilingLock(actor, async () => {
      if ((await proposalStatus(id, actor)) !== "applied")
        throw new Error("This suggestion has no applied board item to undo.");
      const provider = await service.provider(
        { ...actor, botId: proposal.scope.botId! },
        applied.workspaceId,
      );
      const item = await provider.show(applied.itemId);
      const undone = item.status === "closed" && item.closeReason === BOARD_UNDO_REASON;
      const changed = !undone && (item.status === "closed" || item.updatedAt !== applied.updatedAt);
      if (!undone && !changed) await provider.close([item.id], BOARD_UNDO_REASON);
      return operation(id, actor, async (tx, current, _context, audit) => {
        if (current.status !== "applied")
          throw new Error("This suggestion has no applied board item to undo.");
        if (changed) {
          await audit("revert-conflict");
          return {
            proposal: current,
            conflict: {
              before: "",
              applied: applied.itemId,
              current: BOARD_ITEM_CHANGED,
              expectedRevision: 0,
            },
          };
        }
        current.status = "reverted";
        await audit("revert");
        return { proposal: await save(tx, current) };
      });
    });
  }
  async function apply(id: string, actor: Identity, edits?: LearningEdit, grantId?: string) {
    actor = { spaceId: actor.spaceId, userId: actor.userId };
    let committed: { doc: MemoryDocumentHead; context: MemoryOperationContext } | undefined;
    let board: { proposal: LearningProposal; secrets: string[] } | undefined;
    const result = await operation(id, actor, async (tx, proposal, context, audit) => {
      if (proposal.status !== "pending") throw new Error("This suggestion is no longer pending.");
      if (new Date(proposal.expiresAt) <= new Date()) {
        proposal.status = "expired";
        await audit("expired");
        return { proposal: await save(tx, proposal) };
      }
      const blocked = learningApprovalBlock(proposal);
      if (blocked) {
        proposal.blockedReason = blocked;
        await audit("apply-refused");
        return { proposal: await save(tx, proposal) };
      }
      if (grantId) {
        const enabled = await tx.spaceLearningConfig.findUnique({
          where: { spaceId: actor.spaceId },
        });
        const grant = await matchingLearningGrant(tx, actor, proposal);
        if (!enabled?.enabled || !grant || grant.id !== grantId)
          throw new Error("Automatic learning is no longer allowed.");
        const day = new Date();
        day.setUTCHours(0, 0, 0, 0);
        const used = await tx.learningAudit.count({
          where: { grantId, action: "auto-apply", createdAt: { gte: day } },
        });
        if (used >= grant.maxPerDay) throw new Error("The daily learning limit has been reached.");
      }
      if (proposal.operation === "revert-suggestion") {
        if (grantId || edits || !proposal.revertsProposalId)
          throw new Error("Approve this revert explicitly.");
        const originalRow = await tx.learningProposal.findFirst({
          where: { id: proposal.revertsProposalId, ...actor },
        });
        if (!originalRow) throw new IsolationError();
        const original = proposalView(originalRow);
        if (
          original.scope.botId !== proposal.scope.botId ||
          original.type !== proposal.type ||
          original.appliedRevisionId !== proposal.observation?.revisionId ||
          original.documentId !== proposal.target.documentId
        )
          throw new IsolationError();
        const result = await revertChange(tx, original, context, audit, (doc, context) => {
          committed = { doc, context };
        });
        if (result.conflict) return { proposal, conflict: result.conflict };
        proposal.status = "reverted";
        await audit(
          "approve-revert",
          original.appliedRevisionId,
          result.proposal.revertedRevisionId,
        );
        return {
          proposal: await save(tx, proposal, {
            appliedAt: new Date(),
            revertedRevisionId: result.proposal.revertedRevisionId,
          }),
        };
      }
      if (proposal.type === "policy-suggestion") {
        if (
          grantId ||
          edits ||
          !proposal.policyTool ||
          !proposal.scope.botId ||
          !isReadPolicyTool(proposal.policyTool)
        )
          throw new Error("Approve a read-only policy for one bot explicitly.");
        const match = {
          spaceId: actor.spaceId,
          createdByUserId: actor.userId,
          effect: "always_allow",
          matchKind: "tool",
          matchValue: proposal.policyTool,
          scopeKey: `bot:${proposal.scope.botId}`,
        };
        const rule = await tx.actionApprovalRule.upsert({
          where: { spaceId_createdByUserId_effect_matchKind_matchValue_scopeKey: match },
          create: { ...match, botId: proposal.scope.botId },
          update: {},
        });
        proposal.policyRuleId = rule.id;
        proposal.status = "applied";
        await audit("approve-policy");
        return { proposal: await save(tx, proposal, { appliedAt: new Date() }) };
      }
      if (proposal.type === "board-item") {
        if (grantId) throw new Error("Approve this board item explicitly.");
        if (edits || !deps.boardService || !proposal.scope.botId || !proposal.boardItem)
          throw new Error("This board item cannot be applied.");
        board = { proposal, secrets: [...(context.knownSecrets ?? [])] };
        return { proposal };
      }
      if (proposal.operation === "consolidation") {
        if (grantId) throw new Error("Approve consolidation explicitly.");
        for (const participant of proposal.participatingRevisions ?? []) {
          const current = await target(tx, proposal, context, participant.documentId);
          if (!current || current.revision !== participant.revision) {
            proposal.status = "superseded";
            await audit("superseded");
            return { proposal: await save(tx, proposal) };
          }
        }
      }
      const head = await target(tx, proposal, context);
      if ((head?.revision ?? 0) !== (proposal.expectedBaseRevision ?? 0)) {
        proposal.status = "superseded";
        proposal.blockedReason = "This changed since the suggestion was made";
        await audit("superseded");
        return { proposal: await save(tx, proposal) };
      }
      if (edits) {
        await editContent(tx, proposal, context, edits, head);
        await audit("edit");
      }
      if (proposal.proposedContent !== undefined)
        proposal.proposedContent = redactLearningText(
          proposal.proposedContent,
          context.knownSecrets,
        );
      validateContent(proposal);
      if (proposal.type === "preference") {
        const key =
          proposal.typedDelta!.key === "bot.notifyOnFinish" ? "notifyOnFinish" : "autoSpeak";
        const bot = await tx.bot.findFirst({ where: { id: proposal.scope.botId, ...actor } });
        if (
          !bot ||
          typeof proposal.settingBefore !== "boolean" ||
          bot[key] !== proposal.settingBefore
        ) {
          proposal.status = "superseded";
          proposal.blockedReason = "This changed since the suggestion was made";
          await audit("superseded");
          return { proposal: await save(tx, proposal) };
        }
        await tx.bot.update({ where: { id: bot.id }, data: { [key]: proposal.typedDelta!.value } });
      }
      await attribution(tx, proposal, context, head?.revision ?? 0, "apply", grantId);
      const content = proposal.proposedContent ?? JSON.stringify(proposal.typedDelta);
      proposal.diff = proposalDiff(
        redactLearningText(head?.content ?? "", context.knownSecrets),
        content,
      );
      const doc =
        head && proposal.memoryAction === "delete"
          ? await memory().delete(head.id, head.revision, context)
          : head
            ? await memory().commit(
                {
                  id: head.id,
                  kind: proposal.documentKind ?? head.kind,
                  scope: head.scopeKey.kind,
                  botId: proposal.scope.botId,
                  path: head.path,
                  content,
                  references: head.references,
                  expectedRevision: head.revision,
                },
                context,
              )
            : await memory().commit(
                {
                  kind: proposal.documentKind,
                  scope: proposal.scope.botId ? "bot" : "user",
                  botId: proposal.scope.botId,
                  path: `${proposal.type === "skill" ? "skills" : proposal.type === "preference" ? "preferences" : "learned"}/${proposal.id}.md`,
                  content,
                  expectedRevision: 0,
                },
                context,
              );
      if (proposal.type === "skill") {
        const parsed = parseSkillMd(content);
        if ("error" in parsed) throw new Error("This skill is invalid.");
        if (head)
          await tx.agentSkill.updateMany({
            where: { documentId: head.id, ...actor },
            data: {
              name: parsed.name,
              description: parsed.description,
              activeRevision: doc.revision,
              content: "",
            },
          });
        else
          await tx.agentSkill.create({
            data: {
              ...actor,
              botId: proposal.scope.botId,
              name: parsed.name,
              description: parsed.description,
              origin: "learned",
              source: "learned",
              documentId: doc.id,
              activeRevision: doc.revision,
              content: "",
            },
          });
      }
      proposal.status = "applied";
      proposal.documentId = doc.id;
      await audit(
        grantId ? "auto-apply" : "approve",
        head ? `${head.id}:${head.revision}` : undefined,
        `${doc.id}:${doc.revision}`,
        grantId,
      );
      const saved = await save(tx, proposal, {
        appliedRevisionId: `${doc.id}:${doc.revision}`,
        appliedAt: new Date(),
        grantId,
      });
      committed = { doc, context };
      return { proposal: saved };
    });
    if (committed) await memory().schedule(committed.doc, committed.context);
    if (board) return fileBoardItem(id, actor, board.proposal, board.secrets);
    return result;
  }
  return {
    approve: (id: string, actor: Identity, edits?: LearningEdit) => apply(id, actor, edits),
    // Reviewers cannot supply an actor as a substitute for a grant. The grant is read again inside apply.
    async autoApply(id: string, grantId: string) {
      const grant = await deps.prisma.learningGrant.findUnique({ where: { id: grantId } });
      if (!grant) throw new IsolationError();
      return apply(id, { spaceId: grant.spaceId, userId: grant.userId }, undefined, grantId);
    },
    async edit(id: string, actor: Identity, edits: LearningEdit) {
      actor = { spaceId: actor.spaceId, userId: actor.userId };
      return operation(id, actor, async (tx, proposal, context, audit) => {
        if (proposal.status !== "pending" || new Date(proposal.expiresAt) <= new Date())
          throw new Error("This suggestion is no longer pending.");
        if (
          proposal.operation ||
          proposal.type === "policy-suggestion" ||
          proposal.type === "board-item" ||
          learningApprovalBlock(proposal)
        )
          throw new Error("This suggestion cannot be edited here.");
        const head = await target(tx, proposal, context);
        await editContent(tx, proposal, context, edits, head);
        await audit("edit");
        return { proposal: await save(tx, proposal) };
      });
    },
    async reject(id: string, actor: Identity, _reason?: string) {
      const identity = { spaceId: actor.spaceId, userId: actor.userId };
      const reject = (): Promise<LearningActionResult> =>
        operation(id, identity, async (tx, proposal, _context, audit) => {
          if (proposal.status !== "pending")
            throw new Error("This suggestion is no longer pending.");
          const row = await tx.learningProposal.findUniqueOrThrow({ where: { id } });
          for (const fingerprint of new Set([row.fingerprint, proposalFingerprint(proposal)]))
            await tx.learningSuppression.upsert({
              where: { spaceId_userId_fingerprint: { ...identity, fingerprint } },
              create: { ...identity, fingerprint },
              update: proposal.type === "policy-suggestion" ? { createdAt: new Date() } : {},
            });
          proposal.status = "rejected";
          await audit("reject");
          return { proposal: await save(tx, proposal) };
        });
      const row = await deps.prisma.learningProposal.findFirst({
        where: { id, ...identity },
        select: { body: true },
      });
      const body = row?.body as { type?: unknown; scope?: { botId?: string } } | undefined;
      // An approval that already passed its pending check finishes before this reject.
      if (body?.type !== "board-item" || !deps.boardService) return reject();
      const boardService = deps.boardService;
      return boardService.withFilingLock(identity, async () => {
        let leftOpen: { itemId: string; sentence: string } | undefined;
        const filing = await deps.prisma.botBoardFiling.findFirst({
          where: { spaceId: identity.spaceId, learningProposalId: id },
        });
        if (filing?.itemId && filing.workspaceId && !filing.reused) {
          const provider = await boardService.provider(
            {
              ...identity,
              ...(body.scope?.botId || filing.botId
                ? { botId: body.scope?.botId ?? filing.botId ?? undefined }
                : {}),
            },
            filing.workspaceId,
          );
          const item = await provider.show(filing.itemId);
          const rejected = item.status === "closed" && item.closeReason === BOARD_REJECT_REASON;
          const changed =
            !rejected && (item.status === "closed" || item.updatedAt !== item.createdAt);
          if (changed) leftOpen = { itemId: filing.itemId, sentence: BOARD_REJECT_LEFT };
          else {
            if (!rejected) await provider.close([item.id], BOARD_REJECT_REASON);
            await deps.prisma.botBoardFiling.deleteMany({
              where: { id: filing.id, spaceId: identity.spaceId },
            });
          }
        } else if (filing && !filing.itemId)
          await deps.prisma.botBoardFiling.deleteMany({
            where: { id: filing.id, spaceId: identity.spaceId },
          });
        const result = await reject();
        return leftOpen
          ? {
              ...result,
              conflict: {
                before: "",
                applied: leftOpen.itemId,
                current: leftOpen.sentence,
                expectedRevision: 0,
              },
            }
          : result;
      });
    },
    async revert(id: string, actor: Identity) {
      actor = { spaceId: actor.spaceId, userId: actor.userId };
      let committed: { doc: MemoryDocumentHead; context: MemoryOperationContext } | undefined;
      let filed: LearningProposal | undefined;
      const result = await operation(id, actor, async (tx, proposal, context, audit) => {
        if (proposal.type !== "board-item")
          return revertChange(tx, proposal, context, audit, (doc, context) => {
            committed = { doc, context };
          });
        if (
          proposal.status !== "applied" ||
          !deps.boardService ||
          !proposal.scope.botId ||
          !proposal.appliedBoardItem
        )
          throw new Error("This suggestion has no applied board item to undo.");
        if (!proposal.appliedBoardItem.duplicate) {
          filed = proposal;
          return { proposal };
        }
        // A reused item belongs to whoever filed it; Undo only removes this proposal's link.
        await tx.botBoardFiling.deleteMany({
          where: { spaceId: actor.spaceId, learningProposalId: proposal.id, reused: true },
        });
        proposal.status = "reverted";
        await audit("revert");
        return { proposal: await save(tx, proposal) };
      });
      if (committed) await memory().schedule(committed.doc, committed.context);
      if (filed) return undoBoardItem(id, actor, filed);
      return result;
    },
  };
}
