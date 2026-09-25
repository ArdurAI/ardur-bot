import type { Actor } from "@ardurbot/contracts";
import { moveOntoThisMacUnavailableMessage } from "@ardurbot/contracts";
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
  const sentence = moveOntoThisMacUnavailableMessage("linux");
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
      hostBridge: { hub: { health: { platform: "linux" } } },
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
  expect(body.json).toMatchObject({ code: "BAD_REQUEST", message: sentence });
  expect(body.json?.message).not.toBe("Internal server error");
});
