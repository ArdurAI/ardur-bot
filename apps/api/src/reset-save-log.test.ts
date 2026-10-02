import type { SandboxProvider } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { createLogger, createTestSink, installLogger } from "@ardurbot/logging";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, expect, it, vi } from "vitest";
import { logUnexpectedRpcError } from "./app.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

afterEach(() => {
  installLogger(createLogger({ service: "ardurbot-api", level: "off", sinks: [] }));
});

it("keeps an untyped host workspace save failure out of reset logs, responses and rows", async () => {
  const sink = createTestSink();
  installLogger(createLogger({ service: "ardurbot-api", sinks: [sink] }));
  const computer = {
    id: "computer",
    spaceId: "space",
    kind: "desktop",
    state: "running",
    scope: "dedicated",
    homeKey: "home",
    providerRef: "host:example",
    connectionId: null,
    maintenanceId: null,
    controlHolder: "none",
    controlLeaseId: null,
    updatedAt: new Date(0),
  };
  const updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    Object.assign(computer, data);
    return { count: 1 };
  });
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
    computer: { findUniqueOrThrow: async () => computer, updateMany },
    run: { findFirst: async () => null },
  } as unknown as PrismaClient;
  const privateMessage = "EACCES: permission denied, /tmp/example/private-folder";
  const exportWorkspace = vi.fn(() => {
    throw new Error(privateMessage);
  });
  const destroy = vi.fn();
  const sandbox = { exportWorkspace, destroy } as unknown as SandboxProvider;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      sandbox,
      home: {},
      env: { sandboxProvider: "desktop" },
    } as unknown as RouterDeps),
    { clientInterceptors: [onError((error, { path }) => logUnexpectedRpcError(error, path))] },
  );
  const actor = {
    spaceId: "space",
    userId: "owner",
    email: "owner@example.invalid",
    isDeploymentOwner: true,
  } satisfies Actor;
  const { response } = await handler.handle(
    new Request("http://127.0.0.1/rpc/computer/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { botId: "bot" } }),
    }),
    { prefix: "/rpc", context: { actor } },
  );

  expect(exportWorkspace).toHaveBeenCalledOnce();
  expect(destroy).not.toHaveBeenCalled();
  expect(computer.state).toBe("error");
  expect(updateMany).toHaveBeenCalledTimes(2);
  expect(sink.events).toHaveLength(1);
  expect(sink.events[0]).toMatchObject({
    level: "error",
    saveFailureReason: "save-failed",
    engineFailureCategory: "permission-denied",
  });
  expect(sink.events[0]?.error).toBeUndefined();
  expect(JSON.stringify(sink.events)).not.toContain(privateMessage);
  expect(JSON.stringify(sink.events)).not.toContain("/tmp/example/private-folder");
  expect(response?.status).toBe(400);
  const body = await response?.json();
  expect(body.json).toMatchObject({
    code: "BAD_REQUEST",
    message: "The workspace could not be saved.",
    data: { saveFailureReason: "save-failed", engineFailureCategory: "permission-denied" },
  });
  expect(JSON.stringify(body)).not.toContain("/tmp/example/private-folder");
  expect(JSON.stringify(computer)).not.toContain("/tmp/example/private-folder");
  expect(JSON.stringify(updateMany.mock.calls)).not.toContain("/tmp/example/private-folder");
});
