import type { BackgroundJob, JobPublisher } from "@ardurbot/adapter-kit";
import { parseBackgroundJob } from "@ardurbot/adapter-kit";
import { assertLocalImportOwner, EncryptedSecretStore } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import { LocalImportRequests } from "./local-import-requests.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const owner = { spaceId: "space", userId: "owner" };
const actor: Actor = { ...owner, email: "owner@example.test", isDeploymentOwner: true };
function identity(value: unknown) {
  expect(value).toEqual(owner);
}
function fixture() {
  const config = {
    id: "config",
    ...owner,
    roots: {},
    manifest: null,
    selection: {},
    autoImport: false,
    importedAt: new Date("2026-09-24T12:00:00Z"),
  };
  const server = {
    id: "server",
    ...owner,
    imported: {},
    env: { API_KEY: true },
    headers: {},
    secretId: null,
    revision: 1,
  };
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: owner.userId })) },
    spaceMember: {
      findUnique: vi.fn(async ({ where }) => {
        identity(where.spaceId_userId);
        return { role: "owner" };
      }),
    },
    localImportConfig: {
      upsert: vi.fn(async ({ where, create }) => {
        identity(where.spaceId_userId);
        identity(create);
        return config;
      }),
      update: vi.fn(async ({ data }) => Object.assign(config, data)),
    },
    localImportRecord: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async ({ where }) => {
        identity(where.config);
        return { configId: config.id };
      }),
      updateMany: vi.fn(async ({ where }) => {
        identity(where.config);
        return { count: 1 };
      }),
    },
    mcpServer: {
      findFirst: vi.fn(async ({ where: { id, ...scope } }) => {
        expect(id).toBe(server.id);
        identity(scope);
        return server;
      }),
      update: vi.fn(async () => server),
      updateMany: vi.fn(async ({ where: { id, ...scope } }) => {
        expect(id).toBe(server.id);
        identity(scope);
        return { count: 1 };
      }),
    },
    secret: { create: vi.fn(async ({ data }) => data) },
    $executeRaw: vi.fn(),
    $transaction: async <T>(action: (tx: unknown) => Promise<T>): Promise<T> => action(prisma),
  };
  let requests: LocalImportRequests;
  const enqueue = vi.fn(async (job: BackgroundJob) => {
    const parsed = parseBackgroundJob(job.name, job.payload);
    if (parsed.name !== "local-import.run") throw new Error("Unexpected job");
    expect(parsed.payload).toEqual({
      ...owner,
      requestId: expect.any(String),
      action: { action: "scan" },
    });
    requests.complete(parsed.payload.requestId, {});
  });
  requests = new LocalImportRequests({ enqueue } as unknown as JobPublisher);
  const handler = new RPCHandler(
    createRouter({
      prisma,
      secrets: new EncryptedSecretStore("fixture-import-encryption-material"),
      localImportRequests: requests,
      env: { webOrigin: "https://app.example.test" },
    } as unknown as RouterDeps),
  );
  const rawCall = async (method: string, input: unknown) => {
    const { response } = await handler.handle(
      new Request(`https://app.example.test/rpc/localImport/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response!;
  };
  const call = async (method: string, input: unknown) => {
    const response = await rawCall(method, input);
    expect(response.status).toBe(200);
    return response.json();
  };
  return { prisma, call, rawCall, requests, enqueue, config };
}

it.each([
  ["status", {}],
  ["configure", { autoImport: true, selection: { "claude-code": ["skills"] } }],
  ["credentials", { serverId: "server", env: { API_KEY: "owner-supplied-fixture" }, headers: {} }],
  ["run", { action: "scan" }],
])("projects the full authenticated actor through the %s handler", async (method, input) => {
  const f = fixture();
  await f.call(method, input);
  expect(f.prisma.spaceMember.findUnique).toHaveBeenCalled();
  if (method === "run") expect(f.enqueue).toHaveBeenCalledOnce();
  if (method === "configure") expect(f.config.selection).toEqual({ "claude-code": ["skills"] });
  if (method === "credentials") expect(f.prisma.secret.create).toHaveBeenCalledOnce();
});

it("answers a custom folder outside the home with a typed, named error", async () => {
  const f = fixture();
  f.config.manifest = {
    scanId: "00000000-0000-4000-8000-000000000099",
    scannedAt: "2026-09-24T12:00:00.000Z",
    platform: "darwin",
    limited: false,
    sources: [
      {
        tool: "codex",
        detected: false,
        defaultMissing: true,
        counts: { instructions: 0, memories: 0, skills: 0, servers: 0, plugins: 0, other: 0 },
        memoryFolders: 0,
      },
    ],
    items: [],
  };
  const response = await f.rawCall("configure", { roots: { codex: "../outside" } });
  expect(response.status).not.toBe(200);
  const body = (await response.json()) as { json: { code: string; message: string } };
  expect(body.json).toMatchObject({
    code: "LOCAL_IMPORT_INVALID_FOLDER",
    message: "Choose a folder inside the owner's home.",
  });
});

it("builds the ownership selector explicitly even when a caller supplies a full actor", async () => {
  const f = fixture();
  await expect(
    assertLocalImportOwner(f.prisma as unknown as PrismaClient, actor),
  ).resolves.toBeUndefined();
});

it("keeps full actor properties out of the strict background job payload", async () => {
  const f = fixture();
  await expect(f.requests.run(actor, { action: "scan" })).resolves.toEqual({});
  expect(f.enqueue).toHaveBeenCalledOnce();
});
