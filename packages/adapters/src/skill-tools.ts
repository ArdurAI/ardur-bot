import { randomUUID } from "node:crypto";
import {
  buildSkillMd,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
  redactSecrets,
  type SkillRecord,
  type SkillSource,
} from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import type { MemoryService } from "@ardurbot/memory";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { boundedKnowledgeText } from "./knowledge-delivery.js";
import type { SkillDocumentOwner } from "./skill-documents.js";
import {
  commitSkillDocument,
  hydrateAgentSkills,
  hydrateBuiltinSkills,
  recordKnowledgeExposure,
  skillDocumentContext,
} from "./skill-documents.js";

export const SKILL_TOOL_NAMES = new Set([
  "skill_read",
  "skill_create",
  "skill_update",
  "skill_delete",
]);

/** Match CreateAgentSkillInput / UpdateAgentSkillInput / parseSkillMd bounds. */
const MAX_SKILL_CONTENT_CHARS = 100_000;
const MAX_SKILL_NAME_CHARS = 80;
const MAX_SKILL_DESCRIPTION_CHARS = 2000;

type SkillOwner = SkillDocumentOwner;

type AgentSkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  documentId?: string | null;
  activeRevision?: number | null;
  origin?: string;
  botId?: string | null;
  protected?: boolean;
};

function asSource(value: string): SkillSource {
  if (["builtin", "plugin", "user", "learned", "imported"].includes(value))
    return value as SkillSource;
  return "unknown";
}

function toRecord(row: AgentSkillRow): SkillRecord & { id: string } {
  const source = asSource(row.source);
  return {
    ...row,
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly:
      isSkillReadOnly(source) ||
      row.protected === true ||
      (row.origin !== undefined && row.origin !== "user" && row.origin !== "learned"),
  };
}

function builtinRecords(): Array<SkillRecord & { id: string }> {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
  }));
}

function rejectOversizedContent(content: string): string | undefined {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `Skill content must be at most ${MAX_SKILL_CONTENT_CHARS} characters.`;
  }
  return undefined;
}

function rejectInvalidSkillFields(name: string, description: string): string | undefined {
  if (!name) return "Skill name is required.";
  if (!description) return "Skill description is required.";
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return `Skill name must be at most ${MAX_SKILL_NAME_CHARS} characters.`;
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return `Skill description must be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`;
  }
  return undefined;
}

export async function listAgentSkillRecords(
  prisma: PrismaClient,
  owner: SkillOwner,
  documents?: MemoryService,
): Promise<Array<SkillRecord & { id: string }>> {
  const rows = await prisma.agentSkill.findMany({
    where: { spaceId: owner.spaceId, userId: owner.userId },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return mergeBuiltinSkills(
    await hydrateBuiltinSkills(documents, owner, builtinRecords()),
    (await hydrateAgentSkills(prisma, documents, owner, rows)).map(toRecord),
  );
}

async function findOwnedSkill(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { skillId?: string; name?: string },
  documents?: MemoryService,
): Promise<(SkillRecord & { id: string }) | null> {
  const skills = await listAgentSkillRecords(prisma, owner, documents);
  if (input.skillId) {
    return skills.find((skill) => skill.id === input.skillId) ?? null;
  }
  if (input.name) return findSkillByName(skills, input.name) ?? null;
  return null;
}

export async function skillReadFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
  documents?: MemoryService,
): Promise<Record<string, unknown>> {
  const skill = await findOwnedSkill(prisma, owner, input, documents);
  if (!skill) return { error: "Skill not found." };
  const content = redactSecrets(skill.content, [...(owner.knownSecrets ?? [])]);
  const result = {
    name: skill.name,
    description: skill.description.slice(0, 500),
    source: skill.source,
    readOnly: skill.readOnly,
    documentId: skill.documentId,
    activeRevision: skill.activeRevision,
    content,
    truncated: false,
  };
  result.content = boundedKnowledgeText(content, (text) => ({ ...result, content: text }));
  result.truncated = result.content !== content;
  if (skill.documentId && skill.activeRevision)
    await recordKnowledgeExposure(prisma, owner, {
      documentId: skill.documentId,
      activeRevision: skill.activeRevision,
      content: result.content,
      truncated: result.truncated,
      kind: "read",
    });
  return result;
}

export async function skillCreateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; description?: string; body?: string; content?: string },
  documents?: MemoryService,
): Promise<Record<string, unknown>> {
  let name = "";
  let description = "";
  let content = "";
  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    name = parsed.name;
    description = parsed.description;
    content = buildSkillMd(parsed);
  } else {
    name = String(input.name ?? "").trim();
    description = String(input.description ?? "").trim();
    const body = String(input.body ?? "").trim();
    if (!name || !description) {
      return {
        error: "Provide name and description (and optional body), or full SKILL.md content.",
      };
    }
    const invalid = rejectInvalidSkillFields(name, description);
    if (invalid) return { error: invalid };
    content = buildSkillMd({ name, description, body });
  }

  const oversized = rejectOversizedContent(content);
  if (oversized) return { error: oversized };

  const existing = await findOwnedSkill(prisma, owner, { name }, documents);
  if (existing) return { error: `A skill named "${existing.name}" already exists.` };

  try {
    if (!documents) return { error: "Skill documents are unavailable." };
    const id = randomUUID();
    const head = await documents.commit(
      {
        scope: owner.botId ? "bot" : "user",
        botId: owner.botId,
        path: `skills/agent-${id}.md`,
        content,
        expectedRevision: 0,
      },
      skillDocumentContext(owner),
    );
    const row = await prisma.agentSkill.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name,
        description,
        id,
        content: "",
        documentId: head.id,
        activeRevision: head.revision,
        source: owner.botId ? "learned" : "user",
        origin: owner.botId ? "learned" : "user",
        botId: owner.botId,
      },
    });
    return {
      ok: true,
      id: row.id,
      name: row.name,
      description: row.description,
      hint: `Created skill. Mention /${row.name} so the user can open it.`,
    };
  } catch {
    return { error: "Could not create skill (name may already exist)." };
  }
}

export async function skillUpdateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: {
    name?: string;
    skillId?: string;
    newName?: string;
    description?: string;
    body?: string;
    content?: string;
    expectedRevision?: number;
  },
  documents?: MemoryService,
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(
    prisma,
    owner,
    {
      skillId: input.skillId,
      name: input.name,
    },
    documents,
  );
  if (!existing) return { error: "Skill not found." };
  if (
    existing.readOnly ||
    !["user", "learned"].includes(existing.source) ||
    existing.id.startsWith("builtin:")
  ) {
    return { error: "Builtin and plugin skills are read-only." };
  }

  if (input.expectedRevision === undefined)
    return { error: "Read the skill and provide its expected revision before saving." };
  let nextContent = existing.content;
  let nextName = existing.name;
  let nextDescription = existing.description;

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    nextName = parsed.name;
    nextDescription = parsed.description;
    nextContent = buildSkillMd(parsed);
  } else {
    const prior = parseSkillMd(existing.content);
    if ("error" in prior) return { error: prior.error };
    // `name` is only a lookup key (see findOwnedSkill above); renames require `newName`.
    nextName = String(input.newName ?? existing.name).trim() || existing.name;
    nextDescription =
      input.description !== undefined ? String(input.description).trim() : existing.description;
    const body = input.body !== undefined ? String(input.body) : prior.body;
    const invalidFields = rejectInvalidSkillFields(nextName, nextDescription);
    if (invalidFields) return { error: invalidFields };
    nextContent = buildSkillMd({
      name: nextName,
      description: nextDescription,
      body,
      frontmatter: prior.frontmatter,
    });
  }

  const invalid = rejectInvalidSkillFields(nextName, nextDescription);
  if (invalid) return { error: invalid };
  const oversized = rejectOversizedContent(nextContent);
  if (oversized) return { error: oversized };

  if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await findOwnedSkill(prisma, owner, { name: nextName }, documents);
    if (clash && clash.id !== existing.id) {
      return { error: `A skill named "${clash.name}" already exists.` };
    }
  }

  try {
    const head = await commitSkillDocument(
      documents,
      owner,
      existing,
      nextContent,
      input.expectedRevision ?? existing.activeRevision ?? 1,
    );
    const updated = await prisma.agentSkill.updateMany({
      where: {
        id: existing.id,
        spaceId: owner.spaceId,
        userId: owner.userId,
        source: existing.source,
      },
      data: {
        name: nextName,
        description: nextDescription,
        content: "",
        documentId: head.id,
        activeRevision: head.revision,
      },
    });
    if (updated.count !== 1) return { error: "Could not update skill." };
    return { ok: true, id: existing.id, name: nextName, description: nextDescription };
  } catch {
    return { error: "Could not update skill." };
  }
}

export async function skillDeleteFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
  documents?: MemoryService,
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(prisma, owner, input, documents);
  if (!existing) return { error: "Skill not found." };
  if (
    existing.readOnly ||
    !["user", "learned"].includes(existing.source) ||
    existing.id.startsWith("builtin:")
  ) {
    return { error: "Builtin and plugin skills are read-only." };
  }
  if (!documents || !existing.documentId || !existing.activeRevision)
    return { error: "Skill documents are unavailable." };
  await documents.delete(existing.documentId, existing.activeRevision, skillDocumentContext(owner));
  return { ok: true, name: existing.name };
}
