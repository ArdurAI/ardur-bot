import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MemoryDocumentStore } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { LocalImportScanner } from "@ardurbot/host-runtime/import/scanner";
import type { JournalDocument } from "@ardurbot/memory";
import { JournalDocumentStore, MemoryService } from "@ardurbot/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalImportService } from "./local-import.js";
import { McpOAuthBroker } from "./mcp-oauth.js";
import { MarkdownFiles } from "./memory/markdown-files.js";
import { ObsidianDocumentStore } from "./memory/obsidian-store.js";
import { EncryptedSecretStore } from "./secrets.js";

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
      if ("lt" in filter) return (actual as Date) < (filter.lt as Date);
      if ("gte" in filter) return (actual as Date) >= (filter.gte as Date);
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
async function fixture(options: { obsidian?: boolean } = {}) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "import-service-")));
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
  let store: MemoryDocumentStore = new JournalDocumentStore(
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
  const restartVault = () => {
    store = new ObsidianDocumentStore({
      files: new MarkdownFiles(path.join(home, "vault")),
      quarantine: new MarkdownFiles(path.join(home, "quarantine")),
      spaceId: owner.spaceId,
      ownerUserId: owner.userId,
      exclusive: async (action) => action(),
    });
  };
  if (options.obsidian) {
    await mkdir(path.join(home, "vault"));
    await mkdir(path.join(home, "quarantine"));
    restartVault();
  }
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
  const records = table({ removedAt: null, documentId: null, config: owner });
  const skills = table();
  const servers = table({ revision: 1, secretId: null });
  const secrets = table();
  const oauthSessions = table();
  const assignments = table();
  let failCommit = false;
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
        const result = await action(prisma);
        if (failCommit) {
          failCommit = false;
          throw new Error("Fixture database commit failed.");
        }
        return result;
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
    restartVault,
    failNextCommit: () => {
      failCommit = true;
    },
    journal: () => journal,
  };
}

describe("local import lifecycle", () => {
  const memoryContext = () => ({
    ...owner,
    operationId: "fixture",
    traceId: "fixture",
    signal: AbortSignal.timeout(60_000),
  });
  it.each([
    ["receipt", "memories"],
    ["commit", "memories"],
    ["receipt", "skills"],
    ["commit", "skills"],
  ] as const)(
    "recovers real Obsidian writes after a %s failure importing %s and restart",
    async (failure, category) => {
      const f = await fixture({ obsidian: true });
      const manifest = await f.scan();
      const action = {
        action: "import",
        scanId: manifest.scanId,
        tool: "claude-code",
        categories: [category],
      } as const;
      // The database rolls back; the real vault deliberately does not participate in it.
      if (failure === "receipt")
        f.records.upsert.mockRejectedValueOnce(new Error("Fixture receipt failed."));
      else f.failNextCommit();
      await expect(
        f.service.run(owner, { ...action, categories: [...action.categories] }),
      ).rejects.toThrow(/Fixture/);
      expect(f.records.rows).toHaveLength(0);
      const before = await f.documents.list({ scope: "user" }, memoryContext());
      expect(before.items).toHaveLength(1);
      f.restartVault();
      const result = await f.service.run(owner, { ...action, categories: [...action.categories] });
      expect(result.result).toMatchObject({ created: 1, conflicts: 0 });
      const after = await f.documents.list({ scope: "user" }, memoryContext());
      expect(after.items).toHaveLength(1);
      expect(after.items.find((doc) => doc.id === before.items[0]!.id)?.revision).toBe(1);
      expect(f.records.rows).toHaveLength(1);
      expect(f.skills.rows).toHaveLength(category === "skills" ? 1 : 0);
      expect(
        (await f.service.run(owner, { ...action, categories: [...action.categories] })).result,
      ).toMatchObject({ unchanged: 1, created: 0 });
      expect(
        (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
      ).toMatchObject({ removed: 1, conflicts: 0 });
      expect((await f.documents.list({ scope: "user" }, memoryContext())).items).toHaveLength(0);
    },
  );
  it("recovers a durable Obsidian update without creating another revision", async () => {
    const f = await fixture({ obsidian: true });
    await f.importAll();
    const receipt = f.records.rows.find((row) => row.category === "memories")!;
    await f.file(
      ".claude/projects/example/memory/fact.md",
      "Remember the revised offline command.",
    );
    const manifest = await f.scan();
    f.records.upsert.mockRejectedValueOnce(new Error("Fixture receipt failed."));
    const action = { action: "import", scanId: manifest.scanId, categories: ["memories"] } as const;
    await expect(
      f.service.run(owner, { ...action, categories: [...action.categories] }),
    ).rejects.toThrow("Fixture receipt failed.");
    expect(f.records.rows.find((row) => row.id === receipt.id)?.targetRevision).toBe(1);
    f.restartVault();
    expect(
      (await f.service.run(owner, { ...action, categories: [...action.categories] })).result,
    ).toMatchObject({ updated: 1, conflicts: 0 });
    expect((await f.documents.read(String(receipt.documentId), memoryContext()))?.revision).toBe(2);
    expect(
      (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
    ).toMatchObject({ removed: 3, conflicts: 0 });
  });
  it.each(["receipt", "commit"] as const)(
    "recovers an unfinished Obsidian re-import after Undo and a %s failure",
    async (failure) => {
      const f = await fixture({ obsidian: true });
      await f.importAll();
      const id = String(f.records.rows.find((row) => row.category === "memories")!.documentId);
      await f.service.run(owner, { action: "undo", tool: "claude-code" });
      const removedReceipt = structuredClone(f.records.rows.find((row) => row.documentId === id));
      const manifest = await f.scan();
      const action = {
        action: "import",
        scanId: manifest.scanId,
        categories: ["memories"],
      } as const;
      if (failure === "receipt")
        f.records.upsert.mockRejectedValueOnce(new Error("Fixture receipt failed."));
      else f.failNextCommit();
      await expect(
        f.service.run(owner, { ...action, categories: [...action.categories] }),
      ).rejects.toThrow(/Fixture/);
      expect(f.records.rows.find((row) => row.documentId === id)).toEqual(removedReceipt);
      f.restartVault();
      expect(
        (await f.service.run(owner, { ...action, categories: [...action.categories] })).result,
      ).toMatchObject({ created: 1, conflicts: 0 });
      expect(await f.documents.read(id, memoryContext())).toMatchObject({
        revision: 3,
        deletedAt: null,
      });
      expect(
        (await f.service.run(owner, { ...action, categories: [...action.categories] })).result,
      ).toMatchObject({ unchanged: 1, created: 0, conflicts: 0 });
      expect(
        (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
      ).toMatchObject({ removed: 1, conflicts: 0 });
      expect((await f.documents.read(id, memoryContext()))?.revision).toBe(4);
    },
  );
  it("preserves an intervening manual edit to an unreceipted Obsidian note", async () => {
    const f = await fixture({ obsidian: true });
    const manifest = await f.scan();
    const action = { action: "import", scanId: manifest.scanId, categories: ["memories"] } as const;
    f.records.upsert.mockRejectedValueOnce(new Error("Fixture receipt failed."));
    await expect(
      f.service.run(owner, { ...action, categories: [...action.categories] }),
    ).rejects.toThrow("Fixture receipt failed.");
    const head = (await f.documents.list({ scope: "user" }, memoryContext())).items[0]!;
    await f.documents.commit(
      {
        id: head.id,
        scope: "user",
        path: head.path,
        content: "Keep this manual correction.",
        expectedRevision: head.revision,
      },
      memoryContext(),
    );
    f.restartVault();
    expect(
      (await f.service.run(owner, { ...action, categories: [...action.categories] })).result,
    ).toMatchObject({ conflicts: 1 });
    expect((await f.documents.read(head.id, memoryContext()))?.content).toBe(
      "Keep this manual correction.",
    );
    expect(f.records.rows).toHaveLength(0);
  });
  async function authorizeImportedServer(f: Awaited<ReturnType<typeof fixture>>) {
    const server = f.servers.rows[0]!;
    const secrets = new EncryptedSecretStore("fixture-oauth-encryption-material");
    const stored = await secrets.put(
      JSON.stringify({
        oauth: {
          authorizationRevision: server.revision,
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
    // A real begin reserves this attempt as the server's pending sign-in.
    server.pendingOauthSessionId = stored.id;
    await f.oauthSessions.create({
      data: {
        ...owner,
        id: stored.id,
        serverId: server.id,
        endpoint: server.endpoint,
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        oauthCiphertext: stored.ciphertext,
      },
    });
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/token");
      expect(new URLSearchParams(await request.text()).get("code_verifier")).toBe(
        "fixture-verifier",
      );
      return Response.json({ access_token: "fixture-access", token_type: "bearer" });
    });
    const broker = new McpOAuthBroker(f.prisma as unknown as PrismaClient, secrets, {
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    });
    await broker.complete({
      ...owner,
      sessionId: stored.id,
      state: stored.id,
      code: "fixture-code",
    });
    expect(fetch).toHaveBeenCalledOnce();
    return broker;
  }
  it.each(["update", "undo", "disconnect"])(
    "keeps imported receipts current after real OAuth completion and %s",
    async (next) => {
      const f = await fixture();
      await f.file(
        ".claude/settings.json",
        JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.test/mcp" } } }),
      );
      await f.importAll();
      const broker = await authorizeImportedServer(f);
      const server = f.servers.rows[0]!;
      expect(server.revision).toBe(2);
      expect(f.records.rows.find((row) => row.targetId === server.id)?.targetRevision).toBe(2);
      expect(server.secretId).toEqual(expect.any(String));
      expect(f.secrets.rows).toHaveLength(1);
      if (next === "update") {
        await f.file(
          ".claude/settings.json",
          JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.test/changed" } } }),
        );
        expect((await f.importAll()).result).toMatchObject({ updated: 1, conflicts: 0 });
        expect(f.servers.rows[0]).toMatchObject({
          endpoint: "https://mcp.example.test/changed",
          secretId: null,
        });
      } else {
        if (next === "disconnect") {
          await broker.disconnect({ ...owner, serverId: String(server.id) });
          expect(f.records.rows.find((row) => row.targetId === server.id)?.targetRevision).toBe(3);
        }
        expect(
          (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
        ).toMatchObject({ removed: 3, conflicts: 0 });
        expect(f.servers.rows).toHaveLength(0);
      }
      expect(f.secrets.rows).toHaveLength(0);
    },
  );
  it.each(["exchange", "discovery"] as const)(
    "refreshes and undoes a connected imported server after its re-authorization fails at %s",
    async (phase) => {
      const f = await fixture();
      await f.file(
        ".claude/settings.json",
        JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.test/mcp" } } }),
      );
      await f.importAll();
      const server = f.servers.rows[0]!;
      const secrets = new EncryptedSecretStore("fixture-oauth-encryption-material");
      const context = {
        ...owner,
        operationId: "fixture",
        traceId: "fixture",
        signal: AbortSignal.timeout(10_000),
      };
      const working = await secrets.put(
        JSON.stringify({
          oauth: { tokens: { access_token: "fixture-working", token_type: "bearer" } },
        }),
        context,
      );
      await f.secrets.create({ data: { ...owner, ...working } });
      Object.assign(server, { secretId: working.id, connectionState: "connected" });
      const session = await secrets.put(
        JSON.stringify({
          oauth: {
            authorizationRevision: server.revision,
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
        context,
      );
      server.pendingOauthSessionId = session.id;
      await f.oauthSessions.create({
        data: {
          ...owner,
          id: session.id,
          serverId: server.id,
          endpoint: server.endpoint,
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          oauthCiphertext: session.ciphertext,
        },
      });
      const broker = new McpOAuthBroker(f.prisma as unknown as PrismaClient, secrets, {
        fetch: vi.fn(async () =>
          phase === "exchange"
            ? Response.json({ error: "invalid_grant" }, { status: 400 })
            : Response.json({ access_token: "fixture-next", token_type: "bearer" }),
        ),
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      });
      const attempt = { ...owner, sessionId: session.id };
      if (phase === "exchange") {
        await expect(
          broker.complete({ ...attempt, state: session.id, code: "fixture-code" }),
        ).rejects.toThrow();
        // The callback records the failed exchange; the working tokens are written back.
        await broker.recordAttemptFailure({ ...attempt, kind: "failed" });
      } else {
        await broker.complete({ ...attempt, state: session.id, code: "fixture-code" });
        // Discovery failed after the exchange, so capture puts the working tokens back.
        expect(await broker.restorePriorConnected(String(server.id), session.id, owner)).toBe(true);
      }
      const current = f.servers.rows[0]!;
      const stored = f.secrets.rows.find((row) => row.id === current.secretId)!;
      expect(
        JSON.parse(secrets.load(String(stored.ciphertext), String(stored.id))).oauth.tokens
          .access_token,
      ).toBe("fixture-working");
      expect(f.records.rows.find((row) => row.targetId === current.id)?.targetRevision).toBe(
        current.revision,
      );
      await f.file(
        ".claude/settings.json",
        JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.test/changed" } } }),
      );
      expect((await f.importAll()).result).toMatchObject({ updated: 1, conflicts: 0 });
      expect(
        (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
      ).toMatchObject({ removed: 3, conflicts: 0 });
      expect(f.servers.rows).toHaveLength(0);
    },
  );
  it("does not forgive a manual server definition edit when OAuth completes", async () => {
    const f = await fixture();
    await f.file(
      ".claude/settings.json",
      JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example.test/mcp" } } }),
    );
    await f.importAll();
    f.servers.rows[0]!.revision = 2;
    f.servers.rows[0]!.description = "Manual definition change";
    await authorizeImportedServer(f);
    expect(f.records.rows.find((row) => row.category === "servers")?.targetRevision).toBe(1);
    expect(
      (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
    ).toMatchObject({ removed: 2, conflicts: 1 });
    expect(f.servers.rows[0]).toMatchObject({ description: "Manual definition change" });
  });
  it("previews and imports bearer environment bindings from the canonical sanitized server", async () => {
    const f = await fixture();
    await f.file(
      ".codex/config.toml",
      '[mcp_servers.remote]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "ACCESS_TOKEN"\n[mcp_servers.remote.env]\nACCESS_TOKEN = "discard-source-credential"\n[mcp_servers.remote.http_headers]\nAuthorization = "discard-header-credential"\n',
    );
    const manifest = await f.scan();
    const item = manifest.items.find(
      (item) => item.tool === "codex" && item.category === "servers",
    )!;
    const read = f.scanner.read(manifest.scanId, item.id);
    expect(read.content).toBe(JSON.stringify(read.server, null, 2));
    expect(JSON.stringify(read)).not.toMatch(/discard-source-credential|discard-header-credential/);
    expect(read.server?.headerEnv).toEqual({
      Authorization: { name: "ACCESS_TOKEN", bearer: true },
    });
    expect(
      (await f.service.run(owner, { action: "preview", scanId: manifest.scanId, itemId: item.id }))
        .preview,
    ).toEqual(read);
    const result = await f.service.run(owner, {
      action: "import",
      scanId: manifest.scanId,
      tool: "codex",
      categories: ["servers"],
    });
    expect(result.result).toMatchObject({ created: 1, conflicts: 0 });
    expect(f.servers.rows[0]).toMatchObject({
      env: { ACCESS_TOKEN: true },
      headers: { Authorization: { name: "ACCESS_TOKEN", bearer: true } },
    });
  });
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
  it.each([
    ["journal", false],
    ["Obsidian", true],
  ] as const)(
    "does not reclaim a manually restored note without edits in %s",
    async (_store, obsidian) => {
      const f = await fixture({ obsidian });
      const importMemories = async () => {
        const manifest = await f.scan();
        return f.service.run(owner, {
          action: "import",
          scanId: manifest.scanId,
          categories: ["memories"],
        });
      };
      expect((await importMemories()).result).toMatchObject({ created: 1, conflicts: 0 });
      const receipt = f.records.rows[0]!;
      const id = String(receipt.documentId);
      const original = (await f.documents.history(id, {}, memoryContext())).items[0]!;
      expect(
        (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
      ).toMatchObject({ removed: 1, conflicts: 0 });
      const removedReceipt = structuredClone(f.records.rows[0]);
      const restored = await f.documents.restore(id, original.revision, 2, memoryContext());
      expect(restored).toMatchObject({
        revision: 3,
        content: original.content,
        imported: original.imported,
      });
      if (obsidian) f.restartVault();

      expect((await importMemories()).result).toMatchObject({
        conflicts: 1,
        created: 0,
        updated: 0,
      });
      expect(f.records.rows[0]).toEqual(removedReceipt);
      await f.file(
        ".claude/projects/example/memory/fact.md",
        "An updated source must not replace the restored note.",
      );
      expect((await importMemories()).result).toMatchObject({
        conflicts: 1,
        created: 0,
        updated: 0,
      });
      expect(
        (await f.service.run(owner, { action: "undo", tool: "claude-code" })).result,
      ).toMatchObject({ removed: 0, conflicts: 0 });
      expect(f.records.rows[0]).toEqual(removedReceipt);
      expect(await f.documents.read(id, memoryContext())).toMatchObject({
        revision: 3,
        content: original.content,
        deletedAt: null,
      });
      expect((await f.documents.history(id, {}, memoryContext())).items).toHaveLength(3);
    },
  );
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
