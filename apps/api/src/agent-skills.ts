import { randomUUID } from "node:crypto";
import {
  assertSkillWritable,
  BUILTIN_AGENT_SKILLS,
  commitSkillDocument,
  hydrateAgentSkills,
  hydrateBuiltinSkills,
  skillDocumentContext,
} from "@ardurbot/adapters";
import type { Actor, AgentSkill, AgentSkillSource } from "@ardurbot/contracts";
import {
  buildSkillMd,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
  type SkillSource,
} from "@ardurbot/core";
import { IsolationError, type PrismaClient } from "@ardurbot/db";
import type { MemoryService } from "@ardurbot/memory";
import { ORPCError } from "@orpc/server";

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
  createdAt: Date;
  updatedAt: Date;
};

function asSource(value: string): AgentSkillSource {
  if (["builtin", "plugin", "user", "learned", "imported"].includes(value))
    return value as AgentSkillSource;
  return "unknown";
}

export function mapAgentSkill(row: AgentSkillRow): AgentSkill {
  const source = asSource(row.source);
  return {
    id: row.id,
    documentId: row.documentId,
    activeRevision: row.activeRevision,
    origin: (["user", "learned", "imported"].includes(row.origin ?? "")
      ? row.origin
      : "unknown") as AgentSkill["origin"],
    botId: row.botId,
    protected: row.protected,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: isSkillReadOnly(source as SkillSource),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function builtinCatalog(): AgentSkill[] {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }));
}

export function resolveSkillContent(input: {
  content?: string;
  name?: string;
  description?: string;
  body?: string;
  prior?: { content: string };
}): { name: string; description: string; content: string } {
  const ensureContentLimit = (content: string): string => {
    if (content.length > 100_000) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Skill content must be at most 100000 characters.",
      });
    }
    return content;
  };

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) {
      throw new ORPCError("BAD_REQUEST", { message: parsed.error });
    }
    return {
      name: parsed.name,
      description: parsed.description,
      content: ensureContentLimit(buildSkillMd(parsed)),
    };
  }

  const priorParsed = input.prior ? parseSkillMd(input.prior.content) : null;
  if (priorParsed && "error" in priorParsed) {
    throw new ORPCError("BAD_REQUEST", { message: priorParsed.error });
  }

  const name = (input.name ?? priorParsed?.name ?? "").trim();
  const description = (input.description ?? priorParsed?.description ?? "").trim();
  const body = input.body ?? priorParsed?.body ?? "";
  if (!name || !description) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Provide content (SKILL.md) or name + description (+ optional body)",
    });
  }
  let content: string;
  try {
    content = buildSkillMd({
      name,
      description,
      body,
      frontmatter: priorParsed && !("error" in priorParsed) ? priorParsed.frontmatter : undefined,
    });
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid skill fields.",
    });
  }
  const validated = parseSkillMd(content);
  if ("error" in validated) {
    throw new ORPCError("BAD_REQUEST", { message: validated.error });
  }
  return {
    name: validated.name,
    description: validated.description,
    content: ensureContentLimit(buildSkillMd(validated)),
  };
}

export function createAgentSkillsService(prisma: PrismaClient, documents?: MemoryService) {
  async function owned(actor: Actor, skillId: string) {
    const row = await prisma.agentSkill.findFirst({
      where: {
        id: skillId,
        spaceId: actor.spaceId,
        userId: actor.userId,
      },
    });
    if (!row) throw new IsolationError();
    const hydrated = await hydrateAgentSkills(prisma, documents, actor, [row]);
    if (!hydrated[0]) throw new IsolationError();
    return hydrated[0];
  }

  return {
    async list(actor: Actor): Promise<Omit<AgentSkill, "content">[]> {
      const rows = await prisma.agentSkill.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, enabled: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return mergeBuiltinSkills(
        await hydrateBuiltinSkills(documents, actor, builtinCatalog()),
        (await hydrateAgentSkills(prisma, documents, actor, rows)).map(mapAgentSkill),
      ).map(({ content: _content, ...entry }) => entry);
    },

    async listWithContent(actor: Actor): Promise<AgentSkill[]> {
      const rows = await prisma.agentSkill.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, enabled: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      return mergeBuiltinSkills(
        await hydrateBuiltinSkills(documents, actor, builtinCatalog()),
        (await hydrateAgentSkills(prisma, documents, actor, rows)).map(mapAgentSkill),
      );
    },

    async get(actor: Actor, input: { skillId?: string; name?: string }): Promise<AgentSkill> {
      if (input.skillId?.startsWith("builtin:")) {
        const builtin = (await hydrateBuiltinSkills(documents, actor, builtinCatalog())).find(
          (skill) => skill.id === input.skillId,
        );
        if (!builtin) throw new IsolationError();
        return builtin;
      }
      if (input.skillId) {
        return mapAgentSkill(await owned(actor, input.skillId));
      }
      const name = input.name?.trim() ?? "";
      const rows = await prisma.agentSkill.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      const row = findSkillByName(await hydrateAgentSkills(prisma, documents, actor, rows), name);
      if (row) return mapAgentSkill(row);
      const builtin = findSkillByName(
        await hydrateBuiltinSkills(documents, actor, builtinCatalog()),
        name,
      );
      if (!builtin) throw new IsolationError();
      return builtin;
    },

    async create(
      actor: Actor,
      input: { content?: string; name?: string; description?: string; body?: string },
    ): Promise<AgentSkill> {
      const resolved = resolveSkillContent(input);
      const clash = await prisma.agentSkill.findFirst({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: { equals: resolved.name, mode: "insensitive" },
        },
      });
      if (
        clash ||
        builtinCatalog().some((s) => s.name.toLowerCase() === resolved.name.toLowerCase())
      ) {
        throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
      }
      try {
        if (!documents) throw new IsolationError();
        const id = randomUUID();
        const document = await documents.commit(
          {
            scope: "user",
            path: `skills/agent-${id}.md`,
            content: resolved.content,
            expectedRevision: 0,
          },
          skillDocumentContext(actor),
        );
        const row = await prisma.agentSkill.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: resolved.name,
            description: resolved.description,
            id,
            content: "",
            documentId: document.id,
            activeRevision: document.revision,
            source: "user",
            origin: "user",
          },
        });
        return mapAgentSkill({ ...row, content: document.content });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "P2002"
        ) {
          throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
        }
        throw error;
      }
    },

    async update(
      actor: Actor,
      input: {
        skillId: string;
        expectedRevision: number;
        protected?: boolean;
        content?: string;
        name?: string;
        description?: string;
        body?: string;
      },
    ): Promise<AgentSkill> {
      const existing = await owned(actor, input.skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      const resolved = resolveSkillContent({ ...input, prior: existing });
      if (!findSkillByName([existing], resolved.name)) {
        const clash = await prisma.agentSkill.findFirst({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: { equals: resolved.name, mode: "insensitive" },
            NOT: { id: existing.id },
          },
        });
        if (
          clash ||
          builtinCatalog().some((s) => s.name.toLowerCase() === resolved.name.toLowerCase())
        ) {
          throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
        }
      }
      assertSkillWritable(existing, actor);
      const document = await commitSkillDocument(
        documents,
        actor,
        existing,
        resolved.content,
        input.expectedRevision ?? existing.activeRevision ?? 1,
      );
      try {
        const updated = await prisma.agentSkill.updateMany({
          where: {
            id: existing.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            source: existing.source,
          },
          data: {
            name: resolved.name,
            description: resolved.description,
            content: "",
            documentId: document.id,
            activeRevision: document.revision,
            protected: input.protected,
          },
        });
        if (updated.count !== 1) throw new IsolationError();
      } catch (error) {
        if (error instanceof IsolationError) throw error;
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: string }).code === "P2002"
        ) {
          throw new ORPCError("CONFLICT", { message: "A skill with that name already exists." });
        }
        throw error;
      }
      const row = await prisma.agentSkill.findFirst({
        where: {
          id: existing.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
      });
      if (!row) throw new IsolationError();
      return mapAgentSkill({ ...row, content: document.content });
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const existing = await owned(actor, skillId);
      if (isSkillReadOnly(asSource(existing.source) as SkillSource)) {
        throw new ORPCError("BAD_REQUEST", { message: "Builtin and plugin skills are read-only." });
      }
      assertSkillWritable(existing, actor);
      if (!documents || !existing.documentId || !existing.activeRevision)
        throw new IsolationError();
      await documents.delete(
        existing.documentId,
        existing.activeRevision,
        skillDocumentContext(actor),
      );
      return { ok: true };
    },
  };
}

export type AgentSkillsService = ReturnType<typeof createAgentSkillsService>;
