import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackgroundJob, JobPublisher } from "@ardurbot/adapter-kit";
import { parseBackgroundJob } from "@ardurbot/adapter-kit";
import {
  createMemoryLifecycle,
  EncryptedSecretStore,
  LocalImportService,
  McpOAuthBroker,
} from "@ardurbot/adapters";
import { createDb } from "@ardurbot/db";
import { LocalImportScanner } from "@ardurbot/host-runtime/import/scanner";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveImportedServerCredentials } from "./local-import-credentials.js";
import { LocalImportRequests } from "./local-import-requests.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;
describePostgres("local import receipts, journal and credentials (PostgreSQL)", () => {
  const owner = { spaceId: "local-import-fixture-space", userId: "local-import-fixture-owner" };
  let db: ReturnType<typeof createDb>;
  let home: string;
  let service: LocalImportService;
  let documents: ReturnType<typeof createMemoryLifecycle>["service"];
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
    documents = lifecycle.service;
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
  it("accepts full actors through every import RPC and preserves receipts through OAuth and Undo", async () => {
    await file(
      ".codex/config.toml",
      '[mcp_servers.remote]\nurl = "https://mcp.example.test/mcp"\nbearer_token_env_var = "ACCESS_TOKEN"\n',
    );
    let requests: LocalImportRequests;
    requests = new LocalImportRequests({
      enqueue: async (job: BackgroundJob) => {
        const parsed = parseBackgroundJob(job.name, job.payload);
        if (parsed.name !== "local-import.run") throw new Error("Unexpected fixture job.");
        const response = await service.run(owner, parsed.payload.action);
        requests.complete(parsed.payload.requestId, response);
      },
    } as JobPublisher);
    const handler = new RPCHandler(
      createRouter({
        prisma: db.prisma,
        secrets,
        localImportRequests: requests,
        env: { webOrigin: "https://app.example.test" },
      } as unknown as RouterDeps),
    );
    const call = async (method: string, input: unknown) => {
      const { response } = await handler.handle(
        new Request(`https://app.example.test/rpc/localImport/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: input }),
        }),
        {
          prefix: "/rpc",
          context: { actor: { ...owner, email: "owner@example.test", isDeploymentOwner: true } },
        },
      );
      expect(response?.status).toBe(200);
    };
    await call("status", {});
    await call("run", { action: "scan" });
    const manifest = (await service.status(owner)).manifest!;
    await call("run", {
      action: "import",
      scanId: manifest.scanId,
      tool: "codex",
      categories: ["servers"],
    });
    await call("configure", { autoImport: true, selection: { codex: ["servers"] } });
    expect((await service.status(owner)).selection).toEqual({ codex: ["servers"] });
    const server = await db.prisma.mcpServer.findFirstOrThrow({ where: owner });
    await call("credentials", {
      serverId: server.id,
      env: { ACCESS_TOKEN: "fixture-owned-value" },
      headers: {},
    });
    const before = await db.prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
    const material = await secrets.put(
      JSON.stringify({
        oauth: {
          authorizationRevision: before.revision,
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          codeVerifier: "fixture-verifier",
          clientInformation: { client_id: "fixture-client" },
          discoveryState: {
            authorizationServerUrl: "https://auth.example.test",
            resourceMetadata: {
              resource: server.endpoint,
              authorization_servers: ["https://auth.example.test"],
            },
            authorizationServerMetadata: {
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code"],
            },
          },
        },
      }),
      { ...owner, operationId: "fixture", traceId: "fixture", signal: AbortSignal.timeout(10_000) },
    );
    await db.prisma.mcpOAuthSession.create({
      data: {
        id: material.id,
        ...owner,
        serverId: server.id,
        endpoint: server.endpoint!,
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        oauthCiphertext: material.ciphertext,
      },
    });
    // A real begin reserves this attempt as the server's pending sign-in.
    await db.prisma.mcpServer.update({
      where: { id: server.id },
      data: { pendingOauthSessionId: material.id },
    });
    const broker = new McpOAuthBroker(db.prisma, secrets, {
      fetch: async () => Response.json({ access_token: "fixture-access", token_type: "bearer" }),
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    await broker.complete({
      ...owner,
      sessionId: material.id,
      state: material.id,
      code: "fixture-code",
    });
    await broker.disconnect({ ...owner, serverId: server.id });
    const after = await db.prisma.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(after.revision).toBe(before.revision + 2);
    expect(
      (
        await db.prisma.localImportRecord.findFirstOrThrow({
          where: { targetId: server.id, config: owner },
        })
      ).targetRevision,
    ).toBe(after.revision);
    await call("run", { action: "undo", tool: "codex" });
    expect(await db.prisma.mcpServer.count({ where: owner })).toBe(0);
    expect(await db.prisma.secret.count({ where: owner })).toBe(0);
  });
  it("keeps a manually restored note independent of imports and Undo without another edit", async () => {
    await rm(path.join(home, ".claude/projects/fixture/memory/fact.md"));
    const source = ".claude/projects/restored/memory/fact.md";
    await file(source, "Keep the restored offline command.");
    const context = {
      ...owner,
      operationId: "fixture-restore",
      traceId: "fixture-restore",
      signal: AbortSignal.timeout(60_000),
    };
    const importMemories = async () => {
      const manifest = (await service.run(owner, { action: "scan" })).manifest!;
      return service.run(owner, {
        action: "import",
        scanId: manifest.scanId,
        tool: "claude-code",
        categories: ["memories"],
      });
    };
    expect((await importMemories()).result).toMatchObject({ created: 1, conflicts: 0 });
    const receipt = await db.prisma.localImportRecord.findFirstOrThrow({
      where: { config: owner, category: "memories", removedAt: null },
    });
    const id = receipt.documentId!;
    const original = (await documents.history(id, {}, context)).items[0]!;
    expect(
      (await service.run(owner, { action: "undo", tool: "claude-code" })).result,
    ).toMatchObject({ removed: 1, conflicts: 0 });
    const removedReceipt = await db.prisma.localImportRecord.findUniqueOrThrow({
      where: { id: receipt.id },
    });
    expect(await documents.restore(id, original.revision, 2, context)).toMatchObject({
      revision: 3,
      content: original.content,
      imported: original.imported,
    });
    expect((await importMemories()).result).toMatchObject({ conflicts: 1, created: 0, updated: 0 });
    await file(source, "A later source change must preserve the restored note.");
    expect((await importMemories()).result).toMatchObject({ conflicts: 1, created: 0, updated: 0 });
    expect(
      (await service.run(owner, { action: "undo", tool: "claude-code" })).result,
    ).toMatchObject({ removed: 0, conflicts: 0 });
    expect(
      await db.prisma.localImportRecord.findUniqueOrThrow({ where: { id: receipt.id } }),
    ).toEqual(removedReceipt);
    expect(await documents.read(id, context)).toMatchObject({
      revision: 3,
      content: original.content,
      deletedAt: null,
    });
    expect((await documents.history(id, {}, context)).items).toHaveLength(3);
  });
});
