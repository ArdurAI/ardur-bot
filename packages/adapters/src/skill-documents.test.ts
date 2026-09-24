import { MemoryAccessError, MemoryConflictError } from "@ardurbot/adapter-kit";
import { buildSkillMd } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { memoryServiceFixture } from "@ardurbot/testkit/memory-fakes";
import { describe, expect, it, vi } from "vitest";
import {
  assertSkillWritable,
  commitSkillDocument,
  hydrateAgentSkills,
  knowledgeHash,
  skillDocumentContext,
} from "./skill-documents.js";
import { listAgentSkillRecords, skillReadFromTool } from "./skill-tools.js";

const owner = { spaceId: "space-1", userId: "user-1", botId: "bot-1" };
function fixture() {
  const row = {
    id: "skill",
    ...owner,
    name: "Steps",
    description: "Repeatable steps",
    content: buildSkillMd({
      name: "Steps",
      description: "Repeatable steps",
      body: "Use numbered steps.",
    }),
    source: "learned",
    origin: "learned",
    protected: false,
    documentId: null as string | null,
    activeRevision: null as number | null,
  };
  const db = {
    agentSkill: {
      findMany: vi.fn(async () => [{ ...row }]),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => {
        if (where.id === row.id) Object.assign(row, data);
        return { count: 1 };
      }),
    },
    runKnowledgeExposure: { createMany: vi.fn() },
  };
  const { service } = memoryServiceFixture(owner);
  return { row, db, prisma: db as unknown as PrismaClient, service };
}

describe("skill document lifecycle", () => {
  it("migrates once, rejects stale edits, restores as a new revision, and lists the active head", async () => {
    const f = fixture();
    const ctx = skillDocumentContext(owner);
    const [initial] = await hydrateAgentSkills(f.prisma, f.service, owner, [f.row]);
    expect(initial?.activeRevision).toBe(1);
    expect(f.row.content).toBe("");
    const changed = buildSkillMd({
      name: "Steps",
      description: "Repeatable steps",
      body: "Check each step.",
    });
    await commitSkillDocument(f.service, owner, f.row, changed, 1);
    await expect(commitSkillDocument(f.service, owner, f.row, "stale", 1)).rejects.toBeInstanceOf(
      MemoryConflictError,
    );
    await f.service.restore(f.row.documentId!, 1, 2, ctx);
    const [restored] = await hydrateAgentSkills(f.prisma, f.service, owner, [f.row]);
    expect(restored).toMatchObject({ activeRevision: 3, content: initial!.content });
    expect((await f.service.exportBundle(ctx)).documents[0]?.revisions).toHaveLength(3);
    await f.service.delete(f.row.documentId!, 3, ctx);
    expect(await hydrateAgentSkills(f.prisma, f.service, owner, [f.row])).toEqual([]);
    await f.service.restore(f.row.documentId!, 1, 4, ctx);
    expect((await hydrateAgentSkills(f.prisma, f.service, owner, [f.row]))[0]?.activeRevision).toBe(
      5,
    );
  });
  it("protects pinned, imported, unknown and other-bot skills from loop writes", async () => {
    const f = fixture();
    const run = { ...owner, runId: "run" };
    for (const patch of [
      { protected: true },
      { origin: "future" },
      { source: "future" },
      { origin: "imported" },
      { botId: "other" },
    ]) {
      expect(() => assertSkillWritable({ ...f.row, ...patch }, run)).toThrow(MemoryAccessError);
    }
    await hydrateAgentSkills(f.prisma, f.service, owner, [f.row]);
    await expect(
      commitSkillDocument(f.service, run, { ...f.row, protected: true }, "change", 1),
    ).rejects.toBeInstanceOf(MemoryAccessError);
    expect((await f.service.read(f.row.documentId!, skillDocumentContext(owner)))?.revision).toBe(
      1,
    );
  });
  it("records reads, including builtins, but does not mistake a catalog listing for exposure", async () => {
    const f = fixture();
    const run = { ...owner, runId: "run", threadId: "thread", attempt: 2 };
    const catalog = await listAgentSkillRecords(f.prisma, run, f.service);
    expect(f.db.runKnowledgeExposure.createMany).not.toHaveBeenCalled();
    for (const skill of [
      catalog.find((item) => item.id === "skill")!,
      catalog.find((item) => item.source === "builtin")!,
    ]) {
      const read = await skillReadFromTool(f.prisma, run, { skillId: skill.id }, f.service);
      expect(read).toMatchObject({ documentId: skill.documentId, activeRevision: 1 });
      expect(f.db.runKnowledgeExposure.createMany).toHaveBeenLastCalledWith({
        data: [
          expect.objectContaining({
            runId: "run",
            attempt: 2,
            documentId: skill.documentId,
            revisionId: `${skill.documentId}:1`,
            contentHash: knowledgeHash(String(read.content)),
            kind: "read",
            truncated: false,
          }),
        ],
        skipDuplicates: true,
      });
    }
  });
});
