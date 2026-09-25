import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { hydrateAgentSkills } from "@ardurbot/adapters";
import type { Actor, CustomizationSkill } from "@ardurbot/contracts";
import { CustomizationCatalogSchema } from "@ardurbot/contracts";
import type { BundleFile } from "@ardurbot/contracts/bundles/files";
import {
  bundleDocument,
  validateBundleFiles,
  writeBundleFiles,
} from "@ardurbot/contracts/bundles/files";
import catalog from "@ardurbot/contracts/customization-catalog" with { type: "json" };
import { parseSkillMd } from "@ardurbot/core";
import type { AgentSkill, TaughtSkill } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { createAgentSkillsService } from "./agent-skills.js";
import type { RouterDeps } from "./router.js";
import { createTaughtSkillsService } from "./taught-skills.js";

type Kind = CustomizationSkill["kind"];
export const customizationCatalog = CustomizationCatalogSchema.parse(catalog);
export function skillRows(files: AgentSkill[], taught: TaughtSkill[]): CustomizationSkill[] {
  return [
    ...files
      .filter((row) => row.source !== "builtin" && row.componentKind === "skill")
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        kind: (row.origin === "learned" || row.source === "learned" ? "learned" : "file") as Kind,
        source: row.source,
        enabled: row.enabled,
        botId: row.botId,
        pluginId: row.pluginId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    ...taught.map((row) => ({
      id: row.id,
      name: row.name || row.goal,
      description: row.goal,
      kind: "taught" as const,
      source: "user",
      enabled: row.enabled,
      botId: row.botId,
      pluginId: null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  ];
}
export function createCustomizationSkills(deps: RouterDeps) {
  const agents = createAgentSkillsService(deps.prisma, deps.memoryDocuments);
  const taught = createTaughtSkillsService(deps);
  const scope = (actor: Actor) => ({ spaceId: actor.spaceId, userId: actor.userId });
  const folder = (actor: Actor, id: string) =>
    path.join(
      deps.dataDir,
      "skill-bundles",
      createHash("sha256").update(`${actor.spaceId}:${actor.userId}`).digest("hex"),
      id,
    );
  async function list(actor: Actor) {
    const [files, demonstrations] = await Promise.all([
      deps.prisma.agentSkill.findMany({ where: scope(actor), orderBy: { updatedAt: "desc" } }),
      deps.prisma.taughtSkill.findMany({
        where: { ...scope(actor), status: { in: ["saved", "draft"] } },
        orderBy: { updatedAt: "desc" },
      }),
    ]);
    const hydrated = await hydrateAgentSkills(deps.prisma, deps.memoryDocuments, actor, files);
    const activeDemonstrations = [];
    for (const row of demonstrations) {
      if (row.documentId && deps.memoryDocuments) {
        const document = await deps.memoryDocuments.read(row.documentId, {
          ...scope(actor),
          operationId: "skills-list",
          traceId: "skills-list",
          signal: AbortSignal.timeout(10_000),
        });
        if (!document || document.deletedAt) continue;
      }
      activeDemonstrations.push(row);
    }
    return skillRows(hydrated, activeDemonstrations);
  }
  async function owned(actor: Actor, id: string, kind: Kind) {
    const row = (await list(actor)).find((row) => row.id === id && row.kind === kind);
    if (!row) throw new IsolationError();
    return row;
  }
  return {
    list,
    async get(actor: Actor, input: { id: string; kind: Kind }) {
      const row = await owned(actor, input.id, input.kind);
      const content =
        input.kind === "taught"
          ? JSON.stringify((await taught.get(actor, input.id)).playbook, null, 2)
          : (await agents.get(actor, { skillId: input.id })).content;
      return { ...row, content };
    },
    async setEnabled(actor: Actor, input: { id: string; kind: Kind; enabled: boolean }) {
      await owned(actor, input.id, input.kind);
      const where = { ...scope(actor), id: input.id };
      if (input.kind === "taught")
        await deps.prisma.taughtSkill.updateMany({ where, data: { enabled: input.enabled } });
      else await deps.prisma.agentSkill.updateMany({ where, data: { enabled: input.enabled } });
      return { ok: true as const };
    },
    async remove(actor: Actor, input: { id: string; kind: Kind }) {
      const row = await owned(actor, input.id, input.kind);
      if (row.pluginId) throw new Error("Remove this skill by uninstalling its plugin.");
      if (input.kind === "taught") return taught.remove(actor, input.id);
      const result = await agents.remove(actor, input.id);
      const source = await deps.prisma.agentSkill.findFirst({
        where: { ...scope(actor), id: input.id },
      });
      if (source?.bundleId) {
        await deps.prisma.agentSkill.deleteMany({
          where: { ...scope(actor), id: input.id, bundleId: source.bundleId },
        });
        const retained = await deps.prisma.agentSkill.count({
          where: { ...scope(actor), bundleId: source.bundleId },
        });
        if (!retained) await rm(folder(actor, source.bundleId), { recursive: true, force: true });
      }
      return result;
    },
    async import(actor: Actor, files: BundleFile[]) {
      validateBundleFiles(files);
      const documents = files
        .filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
        .map((file) => {
          const content = bundleDocument(files, file.path)!;
          const parsed = parseSkillMd(content);
          if ("error" in parsed) throw new Error(parsed.error);
          return { ...parsed, content };
        });
      if (!documents.length || documents.length > 50)
        throw new Error("Choose a folder or ZIP containing up to 50 SKILL.md files.");
      const names = new Set((await agents.list(actor)).map((row) => row.name.toLowerCase()));
      for (const document of documents) {
        if (names.has(document.name.toLowerCase()))
          throw new Error("A skill with that name already exists.");
        names.add(document.name.toLowerCase());
      }
      const bundleId = randomUUID();
      const directory = folder(actor, bundleId);
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      await writeBundleFiles(directory, files);
      const created: string[] = [];
      try {
        for (const document of documents) {
          const row = await agents.create(actor, { content: document.content });
          created.push(row.id);
          await deps.prisma.agentSkill.updateMany({
            where: { ...scope(actor), id: row.id },
            data: { bundleId },
          });
        }
        return (await list(actor)).filter((row) => created.includes(row.id));
      } catch (error) {
        for (const id of created) await agents.remove(actor, id);
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
