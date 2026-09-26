import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunSandbox } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { HOST_MOVE_UNAVAILABLE_MESSAGE } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it } from "vitest";
import { logUnexpectedRpcError } from "./app.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: true,
} satisfies Actor;

it("returns the host refusal sentence through the RPC handler Settings calls", async () => {
  const prisma = {
    bot: {
      findFirst: async () => ({
        id: "bot",
        spaceId: "space",
        userId: "owner",
        archivedAt: null,
        thread: { id: "thread" },
        computer: { id: "computer", connectionId: "office" },
      }),
    },
    deploymentSettings: {
      findUnique: async () => ({ computerHost: "this-mac" }),
    },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: {
        sandboxProvider: "docker",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        agentRuntime: "scripted",
      },
      dataDir: "/tmp/ardurbot-router-test",
    } as unknown as RouterDeps),
    {
      clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))],
    },
  );
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/computer/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: { botId: "bot", connectionId: null, confirmed: true },
      }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response?.status).toBe(400);
  const body = (await response?.json()) as { json?: { code?: string; message?: string } };
  expect(body.json).toMatchObject({ code: "BAD_REQUEST", message: HOST_MOVE_UNAVAILABLE_MESSAGE });
  expect(body.json?.message).not.toBe("Internal server error");
});

it("rejects a configure request that changes neither the profile nor the connection", async () => {
  const prisma = {
    bot: {
      findFirst: async () => ({
        id: "bot",
        spaceId: "space",
        userId: "owner",
        archivedAt: null,
        thread: { id: "thread" },
        computer: { id: "computer", kind: "docker", connectionId: null },
      }),
    },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: {
        sandboxProvider: "docker",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        agentRuntime: "scripted",
      },
      dataDir: "/tmp/ardurbot-router-test",
    } as unknown as RouterDeps),
    {
      clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))],
    },
  );
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/computer/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot", confirmed: true } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response?.status).toBe(400);
  const body = (await response?.json()) as { json?: { code?: string; message?: string } };
  expect(body.json?.code).toBe("BAD_REQUEST");
  expect(body.json?.message).not.toBe("Internal server error");
});

it("returns the paired desktop's host label with the computer list", async () => {
  const computer = {
    id: "computer",
    kind: "desktop",
    state: "stopped",
    scope: "dedicated",
    controlHolder: "none",
    homeRevision: "saved",
  };
  const prisma = {
    bot: { findMany: async () => [{ id: "bot", name: "Builder", computer }] },
    hostRegistration: { findUnique: async () => ({ platform: "darwin" }) },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({ prisma, env: { sandboxProvider: "docker" } } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/computer/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  const body = (await response?.json()) as { json?: { status: { hostLabel?: string } }[] };
  expect(body.json?.map((entry) => entry.status.hostLabel)).toEqual(["This Mac"]);
});

it("returns the paired desktop's host label from computer.boot", async () => {
  const computer = {
    id: "computer",
    kind: "desktop",
    state: "running",
    scope: "dedicated",
    controlHolder: "none",
    homeRevision: "saved",
    providerRef: "ref",
  };
  const prisma = {
    bot: {
      findFirst: async () => ({
        id: "bot",
        spaceId: "space",
        userId: "owner",
        archivedAt: null,
        thread: { id: "thread" },
        computer,
      }),
    },
    hostRegistration: { findUnique: async () => ({ platform: "darwin" }) },
    computerExecutionLease: { findUnique: async () => null },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: { sandboxProvider: "docker" },
      jobs: { enqueue: async () => undefined },
    } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/computer/boot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  const body = (await response?.json()) as { json?: { hostLabel?: string } };
  expect(body.json?.hostLabel).toBe("This Mac");
});

it("says which engine is missing when a computer is started", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ardurbot-missing-engine-rpc-"));
  const computer = {
    id: "computer",
    kind: "e2b",
    state: "stopped",
    scope: "dedicated",
    homeKey: "home",
    providerRef: null,
    connectionId: null,
    maintenanceId: null,
    controlHolder: "none",
    controlLeaseId: null,
    updatedAt: new Date(0),
  };
  const prisma = {
    bot: {
      findFirst: async () => ({
        id: "bot",
        spaceId: "space",
        userId: "owner",
        archivedAt: null,
        thread: { id: "thread" },
        computer,
      }),
    },
    computer: { findUniqueOrThrow: async () => computer },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: { sandboxProvider: "docker" },
      sandbox: createRunSandbox("docker", { prisma, secrets: { load: () => "" } }),
      home: {},
      dataDir,
    } as unknown as RouterDeps),
    {
      clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))],
    },
  );
  try {
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/computer/boot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { json?: { code?: string; message?: string } };
    expect(body.json).toMatchObject({
      code: "BAD_REQUEST",
      message:
        "This computer runs on E2B, which is not configured here. Reset it in Settings, Computers to start it on this deployment's engine, or configure E2B again.",
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

const missingEngineSentence =
  "This computer runs on E2B, which is not configured here. Reset it in Settings, Computers " +
  "to start it on this deployment's engine, or configure E2B again.";

it("refuses computer.update synchronously on a lost-engine computer instead of queueing it", async () => {
  const computer = {
    id: "computer",
    kind: "e2b",
    state: "stopped",
    scope: "dedicated",
    homeKey: "home",
    providerRef: null,
    connectionId: null,
    maintenanceId: null,
    controlHolder: "none",
    controlLeaseId: null,
    updatedAt: new Date(0),
  };
  const prisma = {
    bot: {
      findFirst: async () => ({
        id: "bot",
        spaceId: "space",
        userId: "owner",
        archivedAt: null,
        thread: { id: "thread" },
        computer,
      }),
    },
    computer: { findUniqueOrThrow: async () => computer },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: { sandboxProvider: "docker" },
      sandbox: createRunSandbox("docker", { prisma, secrets: { load: () => "" } }),
    } as unknown as RouterDeps),
    { clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))] },
  );
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/computer/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response?.status).toBe(400);
  const body = (await response?.json()) as { json?: { code?: string; message?: string } };
  expect(body.json).toMatchObject({ code: "BAD_REQUEST", message: missingEngineSentence });
});

it("refuses a profile-only computer.configure synchronously on a lost-engine computer", async () => {
  const computer = {
    id: "computer",
    kind: "e2b",
    state: "stopped",
    scope: "dedicated",
    homeKey: "home",
    providerRef: null,
    connectionId: null,
    maintenanceId: null,
    controlHolder: "none",
    controlLeaseId: null,
    updatedAt: new Date(0),
  };
  const prisma = {
    bot: {
      findFirst: async () => ({
        id: "bot",
        spaceId: "space",
        userId: "owner",
        archivedAt: null,
        thread: { id: "thread" },
        computer,
      }),
    },
    computer: { findUniqueOrThrow: async () => computer },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: { sandboxProvider: "docker" },
      sandbox: createRunSandbox("docker", { prisma, secrets: { load: () => "" } }),
    } as unknown as RouterDeps),
    { clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))] },
  );
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/computer/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot", imageProfile: "developer", confirmed: true } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response?.status).toBe(400);
  const body = (await response?.json()) as { json?: { code?: string; message?: string } };
  expect(body.json).toMatchObject({ code: "BAD_REQUEST", message: missingEngineSentence });
});

it("refuses capabilities.network synchronously on a lost-engine Docker computer", async () => {
  const computer = {
    id: "computer",
    kind: "remote-docker",
    connectionId: null,
    providerRef: "docker-ref",
    networkEgress: true,
    maintenanceId: null,
    bots: [{ id: "bot" }],
  };
  const prisma = {
    spaceMember: { findUnique: async () => ({ role: "owner" }) },
    computer: { findFirst: async () => computer },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: { sandboxProvider: "docker" },
      sandbox: createRunSandbox("docker", { prisma, secrets: { load: () => "" } }),
    } as unknown as RouterDeps),
    { clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))] },
  );
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/capabilities/network", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: { computerId: "computer", networkEgress: false, confirmed: true },
      }),
    }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response?.status).toBe(400);
  const body = (await response?.json()) as { json?: { code?: string; message?: string } };
  expect(body.json).toMatchObject({
    code: "BAD_REQUEST",
    message:
      "This computer runs on Docker, which is not configured here. Reset it in Settings, " +
      "Computers to start it on this deployment's engine, or configure Docker again.",
  });
});
