import { createHash } from "node:crypto";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { MemoryAccessError, MemoryConflictError } from "@ardurbot/adapter-kit";
import type { MemoryDocumentHead } from "@ardurbot/contracts";
import type { SkillPlaybook, SkillRecord } from "@ardurbot/core";
import {
  extractForcedSkillName,
  extractRoutineSkillMentions,
  findSkillByName,
  formatSkillRunPrompt,
  redactSecrets,
} from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import type { MemoryOperationContext, MemoryService } from "@ardurbot/memory";

export type SkillDocumentOwner = Pick<AdapterContext, "spaceId" | "userId"> & {
  botId?: string;
  runId?: string;
  threadId?: string;
  attempt?: number;
  knownSecrets?: readonly string[];
  memoryModel?: MemoryOperationContext["memoryModel"];
};
export function skillDocumentContext(owner: SkillDocumentOwner): MemoryOperationContext {
  return {
    ...owner,
    operationId: "skill-document",
    traceId: owner.runId ?? "skill-document",
    signal: new AbortController().signal,
  };
}
export type SkillDocumentRow = {
  id: string;
  documentId?: string | null;
  activeRevision?: number | null;
  content: string;
  source: string;
  origin?: string;
  botId?: string | null;
  protected?: boolean;
};
export function assertSkillWritable(row: SkillDocumentRow, owner: SkillDocumentOwner) {
  if (
    (row.source !== "user" && row.source !== "learned") ||
    (row.origin !== undefined && row.origin !== "user" && row.origin !== "learned") ||
    (owner.runId && row.protected) ||
    (row.origin === "learned" && row.botId && owner.botId && row.botId !== owner.botId)
  )
    throw new MemoryAccessError();
}

/** Compatibility columns are migration input only. Once linked, the document is authoritative. */
export async function readSkillDocument(
  service: MemoryService,
  owner: SkillDocumentOwner,
  row: { id: string; documentId?: string | null; content: string; botId?: string | null },
  kind: "agent" | "taught" | "builtin" = "agent",
): Promise<MemoryDocumentHead> {
  const context = skillDocumentContext(owner);
  if (row.documentId) {
    const head = await service.read(row.documentId, context);
    if (!head) throw new MemoryAccessError();
    return head;
  }
  const path = `skills/${kind}-${row.id}.md`;
  const findExisting = async () => {
    const bundle = await service.exportBundle(context);
    const doc = bundle.documents.find((item) => {
      const head = item.revisions.at(-1)!;
      return (
        head.path === path &&
        (row.botId
          ? head.scopeKey.kind === "bot" && head.scopeKey.botId === row.botId
          : head.scopeKey.kind === "user" && head.scopeKey.userId === owner.userId)
      );
    });
    return doc ? service.read(doc.id, context) : null;
  };
  const existing = await findExisting();
  if (existing) return existing;
  try {
    return await service.commit(
      {
        scope: row.botId ? "bot" : "user",
        botId: row.botId ?? undefined,
        path,
        content: row.content,
        expectedRevision: 0,
      },
      context,
    );
  } catch (error) {
    if (error instanceof MemoryConflictError) {
      const winner = await findExisting();
      if (winner) return winner;
    }
    throw error;
  }
}
export async function hydrateAgentSkills<T extends SkillDocumentRow>(
  prisma: PrismaClient,
  service: MemoryService | undefined,
  owner: SkillDocumentOwner,
  rows: T[],
): Promise<Array<T & { revisionId?: string; contentHash?: string }>> {
  if (!service) {
    // Legacy callers may list old rows, but must never treat a linked cache as authoritative.
    if (rows.some((row) => row.documentId)) throw new MemoryAccessError();
    return rows;
  }
  const result = [];
  for (const row of rows) {
    if (row.origin === "learned" && row.botId && owner.botId && row.botId !== owner.botId) continue;
    const head = await readSkillDocument(service, owner, row);
    if (head.deletedAt) continue;
    if (row.documentId !== head.id || row.activeRevision !== head.revision)
      await prisma.agentSkill.updateMany({
        where: { id: row.id, spaceId: owner.spaceId, userId: owner.userId },
        data: { documentId: head.id, activeRevision: head.revision, content: "" },
      });
    result.push({
      ...row,
      content: head.content,
      documentId: head.id,
      activeRevision: head.revision,
      revisionId: `${head.id}:${head.revision}`,
      contentHash: knowledgeHash(head.content),
    });
  }
  return result;
}
export async function commitSkillDocument(
  service: MemoryService | undefined,
  owner: SkillDocumentOwner,
  row: SkillDocumentRow,
  content: string,
  expectedRevision: number,
) {
  assertSkillWritable(row, owner);
  if (!service) throw new MemoryAccessError();
  const head = await readSkillDocument(service, owner, row);
  if (head.revision !== expectedRevision) throw new MemoryConflictError();
  return service.update(head.id, content, expectedRevision, skillDocumentContext(owner));
}
export function knowledgeHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
export async function recordKnowledgeExposure(
  prisma: PrismaClient,
  owner: SkillDocumentOwner,
  input: {
    documentId: string;
    activeRevision: number;
    content: string;
    kind: "injected" | "invoked" | "read";
    truncated?: boolean;
  },
) {
  if (!owner.runId || !owner.threadId || owner.attempt === undefined) return;
  const data = {
    runId: owner.runId,
    threadId: owner.threadId,
    attempt: owner.attempt,
    documentId: input.documentId,
    revisionId: `${input.documentId}:${input.activeRevision}`,
    contentHash: knowledgeHash(redactSecrets(input.content, [...(owner.knownSecrets ?? [])])),
    kind: input.kind,
    truncated: input.truncated ?? false,
  };
  await prisma.runKnowledgeExposure.createMany({ data: [data], skipDuplicates: true });
}

export async function hydrateTaughtSkills<
  T extends {
    id: string;
    botId: string;
    status: string;
    playbook: unknown;
    documentId?: string | null;
    activeRevision?: number | null;
  },
>(
  prisma: PrismaClient,
  service: MemoryService | undefined,
  owner: SkillDocumentOwner,
  rows: T[],
): Promise<T[]> {
  if (!service) {
    if (rows.some((row) => row.documentId)) throw new MemoryAccessError();
    return rows;
  }
  const result: T[] = [];
  for (const row of rows) {
    if (row.status !== "draft" && row.status !== "saved") {
      result.push(row);
      continue;
    }
    const head = await readSkillDocument(
      service,
      owner,
      { ...row, content: JSON.stringify(row.playbook) },
      "taught",
    );
    if (head.deletedAt) continue;
    const playbook = JSON.parse(head.content);
    if (row.documentId !== head.id || row.activeRevision !== head.revision)
      await prisma.taughtSkill.updateMany({
        where: { id: row.id, spaceId: owner.spaceId, userId: owner.userId },
        data: { documentId: head.id, activeRevision: head.revision, playbook: {} },
      });
    result.push({ ...row, documentId: head.id, activeRevision: head.revision, playbook });
  }
  return result;
}

/** Packaged skills get immutable, content-addressed snapshots for exposure and export. */
export async function hydrateBuiltinSkills<T extends { name: string; content: string }>(
  service: MemoryService | undefined,
  owner: SkillDocumentOwner,
  rows: T[],
): Promise<Array<T & { documentId?: string; activeRevision?: number }>> {
  if (!service) return rows;
  const result = [];
  for (const row of rows) {
    const head = await readSkillDocument(
      service,
      { ...owner, runId: undefined },
      {
        id: knowledgeHash(row.content),
        content: row.content,
      },
      "builtin",
    );
    result.push({ ...row, documentId: head.id, activeRevision: head.revision });
  }
  return result;
}

export function invokedKnowledgeExposures(
  prompt: string,
  skills: SkillRecord[],
  taught:
    | {
        documentId?: string | null;
        activeRevision?: number | null;
        name: string;
        playbook: SkillPlaybook;
      }
    | undefined,
) {
  const forced = extractForcedSkillName(prompt);
  const names =
    forced && findSkillByName(skills, forced.name)
      ? [forced.name]
      : extractRoutineSkillMentions(
          prompt,
          skills.map((skill) => skill.name),
        );
  const result: Parameters<typeof recordKnowledgeExposure>[2][] = [];
  for (const name of new Set(names)) {
    const skill = findSkillByName(skills, name);
    if (skill?.documentId && skill.activeRevision)
      result.push({
        documentId: skill.documentId,
        activeRevision: skill.activeRevision,
        content: skill.content.trim(),
        kind: "invoked",
      });
  }
  if (taught?.documentId && taught.activeRevision)
    result.push({
      documentId: taught.documentId,
      activeRevision: taught.activeRevision,
      content: formatSkillRunPrompt(taught.name, taught.playbook),
      kind: "invoked",
    });
  return result;
}
