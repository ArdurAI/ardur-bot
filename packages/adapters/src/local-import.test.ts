import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@ardurbot/db";
import { LocalImportScanner } from "@ardurbot/host-runtime/import/scanner";
import type { JournalDocument } from "@ardurbot/memory";
import { JournalDocumentStore, MemoryService } from "@ardurbot/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalImportService } from "./local-import.js";

type Row = Record<string, unknown>;
type Query = { where?: Row; data?: Row; create?: Row; update?: Row };
const owner = { spaceId: "fixture-space", userId: "fixture-owner" };
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return (expected as Row[]).some((condition) => matches(row, condition));
    if (key.includes("_") && expected && typeof expected === "object")
      return matches(row, expected as Row);
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const filter = expected as Row;
      if ("not" in filter) return actual !== filter.not;
      if ("lte" in filter) return (actual as Date) <= (filter.lte as Date);
      if ("equals" in filter)
        return String(actual).toLowerCase() === String(filter.equals).toLowerCase();
      return matches(actual as Row, filter);
    }
    if (actual instanceof Date && expected instanceof Date)
      return actual.getTime() === expected.getTime();
    return actual === expected;
  });
}
function table(defaults: Row = {}) {
  const rows: Row[] = [];
  const create = vi.fn(async ({ data }: Query) => {
    const row = {
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...structuredClone(defaults),
      ...data,
    };
    rows.push(row);
    return row;
  });
  const findFirst = vi.fn(
    async ({ where = {} }: Query = {}) => rows.find((row) => matches(row, where)) ?? null,
  );
  const update = vi.fn(async ({ where, data = {} }: Query) => {
    const row = await findFirst({ where });
    if (!row) throw new Error("Missing fixture row.");
    for (const [key, value] of Object.entries(data))
      row[key] =
        value && typeof value === "object" && "increment" in value
          ? Number(row[key]) + Number(value.increment)
          : value;
    return row;
  });
  return {
    rows,
    create,
    findFirst,
    findUnique: findFirst,
    findUniqueOrThrow: async (input: Query) => {
      const row = await findFirst(input);
      if (!row) throw new Error("Missing fixture row.");
      return row;
    },
    findMany: vi.fn(async ({ where = {} }: Query = {}) =>
      rows.filter((row) => matches(row, where)),
    ),
    update,
    updateMany: vi.fn(async ({ where, data }: Query) => {
      const selected = rows.filter((row) => matches(row, where));
      for (const row of selected) await update({ where: { id: row.id }, data });
      return { count: selected.length };
    }),
    upsert: vi.fn(async ({ where, create: data, update: patch }: Query) =>
      (await findFirst({ where })) ? update({ where, data: patch }) : create({ data }),
    ),
    deleteMany: vi.fn(async ({ where }: Query) => {
      const selected = rows.filter((row) => matches(row, where));
      for (const row of selected) rows.splice(rows.indexOf(row), 1);
      return { count: selected.length };
    }),
  };
}
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "import-service-"));
  homes.push(home);
  const file = async (name: string, content: string) => {
    const target = path.join(home, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  await file(".claude/projects/example/memory/fact.md", "Remember the offline command.");
  await file(
    ".claude/skills/review/SKILL.md",
    "---\nname: review\ndescription: Review changes\n---\nRead the patch.",
  );
  await file(
    ".claude/settings.json",
    '{"mcpServers":{"search":{"command":"node","args":["server.js"],"env":{"API_KEY":"fixture-secret"}}}}',
  );
  let journal: JournalDocument[] = [];
  const store = new JournalDocumentStore(
    {
      transaction: async (_access, action) => {
        const next = structuredClone(journal);
        const result = await action(next);
        journal = next;
        return result;
      },
    },
    "fixture",
  );
  const documents = new MemoryService({
    enqueue: vi.fn(async () => undefined),
    open: async (context, action) =>
      action({ store, semantic: null, generation: 0, access: { ...context, botIds: [] } }),
  });
  const config = table({
    roots: {},
    manifest: null,
    autoImport: false,
    selection: {},
    importedAt: null,
    lastRefreshAt: null,
  });
  const records = table({ removedAt: null, documentId: null });
  const skills = table();
  const servers = table({ revision: 1, secretId: null });
  const secrets = table();
  const oauthSessions = table();
  const assignments = table();
  const prisma = {
    localImportConfig: config,
    localImportRecord: records,
    agentSkill: skills,
    mcpServer: servers,
    secret: secrets,
    mcpOAuthSession: oauthSessions,
    botMcpServer: assignments,
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: owner.userId })) },
    spaceMember: { findUnique: vi.fn(async () => ({ role: "owner" })) },
    $executeRaw: vi.fn(),
    $transaction: async <T>(action: (tx: unknown) => Promise<T>) => {
      const tables = [config, records, skills, servers, secrets, oauthSessions, assignments];
      const before = tables.map((table) => structuredClone(table.rows));
      const oldJournal = structuredClone(journal);
      try {
        return await action(prisma);
      } catch (error) {
        for (const [i, table] of tables.entries())
          table.rows.splice(0, table.rows.length, ...before[i]!);
        journal = oldJournal;
        throw error;
      }
    },
  };
  const scanner = new LocalImportScanner({ home, platform: "darwin" });
  const service = new LocalImportService({
    prisma: prisma as unknown as PrismaClient,
    documents,
    transport: {
      scan: (_owner, roots) => scanner.scan(roots),
      read: async (_owner, scanId, itemId) => scanner.read(scanId, itemId),
    },
  });
  const scan = async () => (await service.run(owner, { action: "scan" })).manifest!;
  const importAll = async () => {
    const manifest = await scan();
    return service.run(owner, {
      action: "import",
      scanId: manifest.scanId,
      categories: ["memories", "skills", "servers"],
    });
  };
  return {
    file,
    service,
    scanner,
    scan,
    importAll,
    prisma,
    records,
    skills,
    servers,
    secrets,
    oauthSessions,
    assignments,
    config,
    documents,
    journal: () => journal,
  };
}

describe("local import lifecycle", () => {
  it("revokes credentials, pending OAuth and prior tool approval when a server definition changes", async () => {
    const f = await fixture();
    await f.importAll();
    const server = f.servers.rows[0]!;
    server.secretId = "owned-secret";
    f.secrets.rows.push({ id: "owned-secret", ...owner });
    f.oauthSessions.rows.push({ id: "pending", serverId: server.id, ...owner });
    f.assignments.rows.push({
      id: "assignment",
      serverId: server.id,
      needsReview: false,
      ...owner,
    });
    await f.importAll();
    expect(server.secretId).toBe("owned-secret");
    expect(f.assignments.rows[0]!.needsReview).toBe(false);
    await f.file(
      ".claude/settings.json",
      '{"mcpServers":{"search":{"command":"node","args":["changed-server.js"],"env":{"API_KEY":"discarded"}}}}',
    );
    expect((await f.importAll()).result).toMatchObject({ updated: 1, unchanged: 2 });
    expect(server.secretId).toBeNull();
    expect(f.secrets.rows).toHaveLength(0);
    expect(f.oauthSessions.rows).toHaveLength(0);
    expect(f.assignments.rows[0]!.needsReview).toBe(true);
  });
  it("creates documents, skills and server definitions with provenance and no source credentials", async () => {
    const f = await fixture();
    expect((await f.service.status(owner)).autoImport).toBe(false);
    expect((await f.importAll()).result).toMatchObject({ created: 3, updated: 0 });
    expect(f.journal()).toHaveLength(2);
    expect(f.journal()[0]!.revisions[0]!.imported).toMatchObject({
      tool: "claude-code",
      authorizesIntent: false,
      kind: "memories",
    });
    expect(f.skills.rows[0]).toMatchObject({
      source: "imported",
      origin: "imported",
      content: "",
      activeRevision: 1,
    });
    expect(f.servers.rows[0]).toMatchObject({
      env: { API_KEY: true },
      secretId: null,
      description: "Imported from Claude Code",
    });
    expect(JSON.stringify([f.records.rows, f.servers.rows, f.journal()])).not.toContain(
      "fixture-secret",
    );
    expect((await f.service.status(owner)).autoImport).toBe(false);
  });
  it("deduplicates unchanged imports and writes a revision only for the changed source", async () => {
    const f = await fixture();
    await f.importAll();
    expect((await f.importAll()).result).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    await f.file(".claude/projects/example/memory/fact.md", "Use the updated offline command.");
    expect((await f.importAll()).result).toMatchObject({ updated: 1, unchanged: 2 });
    expect(
      f.journal().find((doc) => doc.revisions[0]?.imported?.kind === "memories")?.revisions,
    ).toHaveLength(2);
  });
  it("uses the source prefix only when a skill name collides", async () => {
    const f = await fixture();
    f.skills.rows.push({ id: "existing", ...owner, name: "review" });
    await f.importAll();
    expect(f.skills.rows.map((row) => row.name)).toEqual(["review", "claude-code-review"]);
  });
  it("undo tombstones documents and removes servers, preserving manual edits", async () => {
    const f = await fixture();
    await f.importAll();
    const memory = f.journal().find((doc) => doc.revisions[0]?.imported?.kind === "memories")!;
    await f.documents.update(memory.id, "Owner edit.", 1, {
      ...owner,
      operationId: "edit",
      traceId: "edit",
      signal: new AbortController().signal,
    });
    await f.service.configure(owner, { autoImport: true });
    expect(
      (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
    ).toMatchObject({ removed: 2, conflicts: 1 });
    expect(f.servers.rows).toHaveLength(0);
    expect(
      f
        .journal()
        .find((doc) => doc.revisions[0]?.imported?.kind === "skills")
        ?.revisions.at(-1)?.deletedAt,
    ).toBeTruthy();
    expect((await f.service.status(owner)).autoImport).toBe(false);
    expect(
      f
        .journal()
        .find((doc) => doc.id === memory.id)
        ?.revisions.at(-1)?.content,
    ).toBe("Owner edit.");
  });
  it("deduplicates equal memory bodies and keeps other source provenance after undo", async () => {
    const f = await fixture();
    await f.file(".codex/AGENTS.md", "Remember the offline command.");
    await f.file(".claude/projects/example/memory/same.md", "Remember the offline command.");
    await f.importAll();
    expect(
      f.journal().filter((doc) => doc.revisions[0]?.imported?.kind === "memories"),
    ).toHaveLength(1);
    expect(f.records.rows.filter((row) => row.category === "memories")).toHaveLength(2);
    await f.service.run(owner, { action: "undo", tool: "claude-code" });
    expect((await f.importAll()).result).toMatchObject({ created: 4, conflicts: 0 });
    expect(
      f.journal().filter((doc) => doc.revisions[0]?.imported?.kind === "memories"),
    ).toHaveLength(1);
  });
  it("enables hourly refresh only after consent and makes repeated ticks idempotent", async () => {
    const f = await fixture();
    await f.service.status(owner);
    await expect(f.service.configure(owner, { autoImport: true })).rejects.toThrow(
      "Import some items",
    );
    await f.service.refresh();
    expect(f.journal()).toHaveLength(0);
    await f.importAll();
    await f.service.configure(owner, { autoImport: true });
    await f.file(".claude/projects/example/memory/new.md", "A new fact.");
    await f.service.refresh();
    await f.service.refresh();
    expect(f.records.rows.filter((row) => row.category === "memories")).toHaveLength(2);
    expect(f.journal().flatMap((doc) => doc.revisions)).toHaveLength(3);
  });
  it("splits a changed source from an equal body without overwriting the other source", async () => {
    const f = await fixture();
    await f.file(".claude/projects/example/memory/same.md", "Remember the offline command.");
    await f.importAll();
    await f.file(".claude/projects/example/memory/fact.md", "A changed source.");
    expect((await f.importAll()).result).toMatchObject({ updated: 1, unchanged: 3 });
    const bodies = f
      .journal()
      .filter((doc) => doc.revisions[0]?.imported?.kind === "memories")
      .map((doc) => doc.revisions.at(-1)?.content);
    expect(bodies).toEqual(
      expect.arrayContaining(["A changed source.", "Remember the offline command."]),
    );
  });
  it("undo deletes an owned server secret and a later import creates new document revisions", async () => {
    const f = await fixture();
    await f.importAll();
    f.servers.rows[0]!.secretId = "owned-secret";
    f.secrets.rows.push({ id: "owned-secret", ...owner }, { id: "other-secret", ...owner });
    expect(
      (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result?.removed,
    ).toBe(3);
    expect(f.secrets.rows.map((row) => row.id)).toEqual(["other-secret"]);
    expect((await f.importAll()).result?.created).toBe(3);
    expect(f.journal().map((doc) => doc.revisions.length)).toEqual([3, 3]);
  });
  it("does not overwrite an owner's restored document after undo", async () => {
    const f = await fixture();
    await f.importAll();
    const memory = f.journal().find((doc) => doc.revisions[0]?.imported?.kind === "memories")!;
    await f.service.run(owner, { action: "undo", tool: "claude-code" });
    const context = {
      ...owner,
      operationId: "edit",
      traceId: "edit",
      signal: new AbortController().signal,
    };
    await f.documents.restore(memory.id, 1, 2, context);
    await f.documents.update(memory.id, "Owner restored fact.", 3, context);
    expect((await f.importAll()).result?.conflicts).toBe(1);
    expect(
      f
        .journal()
        .find((doc) => doc.id === memory.id)
        ?.revisions.at(-1)?.content,
    ).toBe("Owner restored fact.");
  });
  it("rolls back a document if its import receipt cannot be persisted", async () => {
    const f = await fixture();
    const scan = await f.scan();
    f.records.upsert.mockRejectedValueOnce(new Error("Fixture persistence failure."));
    await expect(
      f.service.run(owner, { action: "import", scanId: scan.scanId, categories: ["memories"] }),
    ).rejects.toThrow("Fixture persistence failure");
    expect(f.journal()).toHaveLength(0);
    expect(f.records.rows).toHaveLength(0);
  });
  it("rejects non-owners and stale or forged previews before reading", async () => {
    const f = await fixture();
    const scan = await f.scan();
    await expect(
      f.service.run({ ...owner, userId: "someone-else" }, { action: "scan" }),
    ).rejects.toThrow();
    await expect(
      f.service.run(owner, { action: "preview", scanId: scan.scanId, itemId: randomUUID() }),
    ).rejects.toThrow();
    await f.scan();
    await expect(
      f.service.run(owner, { action: "preview", scanId: scan.scanId, itemId: scan.items[0]!.id }),
    ).rejects.toThrow("Re-scan");
  });
});
