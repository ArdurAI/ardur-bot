import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMemoryLifecycle,
  EncryptedSecretStore,
  LocalImportService,
} from "@ardurbot/adapters";
import { createDb } from "@ardurbot/db";
import { LocalImportScanner } from "@ardurbot/host-runtime/import/scanner";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveImportedServerCredentials } from "./local-import-credentials.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
describePostgres("local import receipts, journal and credentials (PostgreSQL)", () => {
  const owner = { spaceId: "local-import-fixture-space", userId: "local-import-fixture-owner" };
  let db: ReturnType<typeof createDb>;
  let home: string;
  let service: LocalImportService;
  const secrets = new EncryptedSecretStore("fixture-local-import-encryption-material");
  const file = async (relative: string, body: string) => {
    const target = path.join(home, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  };
  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "local-import-postgres-"));
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.user.create({
      data: { id: owner.userId, name: "Import fixture", email: "local-import@example.invalid" },
    });
    await db.prisma.organization.create({
      data: {
        id: owner.spaceId,
        name: "Import fixture",
        slug: owner.spaceId,
        createdAt: new Date(),
        spaces: { create: { id: owner.spaceId, name: "Import fixture" } },
        members: {
          create: {
            id: "local-import-fixture-org-member",
            userId: owner.userId,
            role: "owner",
            createdAt: new Date(),
          },
        },
      },
    });
    await db.prisma.spaceMember.create({
      data: {
        id: "local-import-fixture-membership",
        ...owner,
        organizationId: owner.spaceId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await db.prisma.deploymentSettings.create({
      data: { id: "default", ownerUserId: owner.userId },
    });
    await file(".claude/projects/fixture/memory/fact.md", "Use the offline build command.");
    await file(
      ".claude/skills/review/SKILL.md",
      "---\nname: review\ndescription: Review a change\n---\nRead the patch.",
    );
    await file(
      ".claude/settings.json",
      '{"mcpServers":{"search":{"command":"node","env":{"API_KEY":"discard-this-source-value"}}}}',
    );
    const lifecycle = createMemoryLifecycle({
      prisma: db.prisma,
      secrets,
      dataDir: path.join(home, "data"),
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: async () => undefined,
        close: async () => undefined,
      },
    });
    const scanner = new LocalImportScanner({ home, platform: "darwin" });
    service = new LocalImportService({
      prisma: db.prisma,
      documents: lifecycle.service,
      transport: {
        scan: (_owner, roots) => scanner.scan(roots),
        read: async (_owner, scanId, itemId) => scanner.read(scanId, itemId),
      },
    });
  });
  afterAll(async () => {
    if (db) {
      try {
        await db.prisma.deploymentSettings.deleteMany({ where: { ownerUserId: owner.userId } });
        await db.prisma.organization.deleteMany({ where: { id: owner.spaceId } });
        await db.prisma.user.deleteMany({ where: { id: owner.userId } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }
    if (home) await rm(home, { recursive: true, force: true });
  });
  it("commits provenance atomically, encrypts supplied values, deduplicates changes and undoes through tombstones", async () => {
    const manifest = (await service.run(owner, { action: "scan" })).manifest!;
    expect(JSON.stringify(manifest)).not.toContain("discard-this-source-value");
    expect(
      (
        await service.run(owner, {
          action: "import",
          scanId: manifest.scanId,
          categories: ["memories", "skills", "servers"],
        })
      ).result?.created,
    ).toBe(3);
    expect(await db.prisma.learningProposal.count({ where: owner })).toBe(0);
    const receipts = await db.prisma.localImportRecord.findMany({ where: { config: owner } });
    expect(receipts).toHaveLength(3);
    const memory = receipts.find((row) => row.category === "memories")!;
    const revisions = await db.prisma.memoryRevision.findMany({
      where: { documentId: memory.documentId! },
    });
    expect(revisions[0]!.imported).toMatchObject({
      tool: "claude-code",
      kind: "memories",
      authorizesIntent: false,
    });
    const server = await db.prisma.mcpServer.findFirstOrThrow({ where: owner });
    await expect(
      saveImportedServerCredentials(db.prisma, secrets, owner, {
        serverId: server.id,
        env: {},
        headers: {},
      }),
    ).rejects.toThrow("each listed field");
    await saveImportedServerCredentials(db.prisma, secrets, owner, {
      serverId: server.id,
      env: { API_KEY: "new-owner-supplied-value" },
      headers: {},
    });
    const saved = await db.prisma.mcpServer.findUniqueOrThrow({
      where: { id: server.id },
      include: { secret: true },
    });
    expect(saved.secret!.ciphertext).not.toContain("new-owner-supplied-value");
    expect(JSON.parse(secrets.load(saved.secret!.ciphertext, saved.secret!.id))).toEqual({
      env: { API_KEY: "new-owner-supplied-value" },
      headers: {},
    });
    expect(
      (
        await service.run(owner, {
          action: "import",
          scanId: manifest.scanId,
          categories: ["memories", "skills", "servers"],
        })
      ).result?.unchanged,
    ).toBe(3);
    await file(".claude/projects/fixture/memory/fact.md", "Use the updated offline build command.");
    const changed = (await service.run(owner, { action: "scan" })).manifest!;
    expect(
      (
        await service.run(owner, {
          action: "import",
          scanId: changed.scanId,
          categories: ["memories", "skills", "servers"],
        })
      ).result,
    ).toMatchObject({ updated: 1, unchanged: 2 });
    await db.prisma.mcpOAuthSession.create({
      data: {
        id: "local-import-pending-oauth",
        ...owner,
        serverId: server.id,
        endpoint: "https://example.test/mcp",
        redirectUri: "https://app.example.test/mcp/oauth/callback",
        oauthCiphertext: "fixture-encrypted-session",
      },
    });
    await file(
      ".claude/settings.json",
      '{"mcpServers":{"search":{"command":"node","args":["changed-server.js"],"env":{"API_KEY":"discard-another-value"}}}}',
    );
    const changedServer = (await service.run(owner, { action: "scan" })).manifest!;
    expect(
      (
        await service.run(owner, {
          action: "import",
          scanId: changedServer.scanId,
          categories: ["servers"],
        })
      ).result?.updated,
    ).toBe(1);
    expect(
      (await db.prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } })).secretId,
    ).toBeNull();
    expect(await db.prisma.secret.count({ where: owner })).toBe(0);
    expect(await db.prisma.mcpOAuthSession.count({ where: owner })).toBe(0);
    await saveImportedServerCredentials(db.prisma, secrets, owner, {
      serverId: server.id,
      env: { API_KEY: "replacement-owner-supplied-value" },
      headers: {},
    });
    expect(
      (await service.run(owner, { action: "undo", tool: "claude-code" })).result?.removed,
    ).toBe(3);
    expect(await db.prisma.mcpServer.count({ where: owner })).toBe(0);
    expect(await db.prisma.secret.count({ where: owner })).toBe(0);
    const history = await db.prisma.memoryRevision.findMany({
      where: { documentId: memory.documentId! },
      orderBy: { revision: "asc" },
    });
    expect(history.map((revision) => revision.revision)).toEqual([1, 2, 3]);
    expect(history[2]!.deletedAt).not.toBeNull();
    expect(history[2]!.imported).toMatchObject({ tool: "claude-code" });
    expect((await service.status(owner)).autoImport).toBe(false);
  });
});
