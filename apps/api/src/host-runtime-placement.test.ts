import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
const request = (json: object) =>
  new Request("http://127.0.0.1/rpc/computer/configure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json }),
  });

it.each([
  { owner: false, pairedOwner: "owner", connected: true, confirmed: true, expected: 403 },
  { owner: true, pairedOwner: "other", connected: true, confirmed: true, expected: 400 },
  { owner: true, pairedOwner: "owner", connected: false, confirmed: true, expected: 400 },
  { owner: true, pairedOwner: "owner", connected: true, confirmed: false, expected: 400 },
])(
  "refuses an unauthorized or unconfirmed host move before queueing: %j",
  async ({ owner, pairedOwner, connected, confirmed, expected }) => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    const enqueue = vi.fn();
    const transaction = vi.fn();
    const prisma = {
      bot: {
        findFirst: async () => ({
          id: "bot",
          spaceId: "space",
          userId: "owner",
          runtimeKind: "codex-app-server",
          thread: { id: "thread" },
          computer: {
            id: "computer",
            kind: "desktop",
            connectionId: "container",
            spaceId: "space",
          },
        }),
      },
      hostRegistration: { findUnique: async () => ({ userId: pairedOwner }) },
      $transaction: transaction,
    } as unknown as PrismaClient;
    try {
      const handler = new RPCHandler(
        createRouter({
          prisma,
          env: { sandboxProvider: "docker" },
          hostBridge: { status: async () => ({ connected }) },
          jobs: { enqueue },
        } as unknown as RouterDeps),
      );
      const { response } = await handler.handle(
        request({ botId: "bot", destination: "host", confirmed }),
        { prefix: "/rpc", context: { actor: { ...actor, isDeploymentOwner: owner } } },
      );
      expect(response?.status).toBe(expected);
      expect(transaction).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
it("rejects an empty connection ID at the RPC boundary before reading a computer", async () => {
  const findFirst = vi.fn();
  const handler = new RPCHandler(
    createRouter({
      prisma: { bot: { findFirst } },
      env: { sandboxProvider: "docker" },
    } as unknown as RouterDeps),
  );
  const { response } = await handler.handle(
    request({ botId: "bot", connectionId: "", confirmed: true }),
    { prefix: "/rpc", context: { actor } },
  );
  expect(response?.status).toBe(400);
  expect(findFirst).not.toHaveBeenCalled();
});
