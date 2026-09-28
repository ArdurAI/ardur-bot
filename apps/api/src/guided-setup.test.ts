import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import { guidedSetupStatus } from "./guided-setup.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "user-a",
  spaceId: "space-a",
  email: "example@test.invalid",
  isDeploymentOwner: true,
};

function fixture(selected: boolean, bot: boolean) {
  const findPreference = vi.fn(async () =>
    selected ? { credential: { provider: "local" }, modelId: "chosen", isDefault: true } : null,
  );
  const findBot = vi.fn(async () => (bot ? { id: "bot-a" } : null));
  return {
    prisma: {
      spaceModelPreference: { findFirst: findPreference },
      bot: { findFirst: findBot },
    } as unknown as PrismaClient,
    findPreference,
    findBot,
  };
}

describe("guided setup account status", () => {
  it("reports only persisted selected model and first bot state", async () => {
    const { prisma, findPreference, findBot } = fixture(true, true);
    const status = await guidedSetupStatus(prisma, actor);
    expect(status.model).toBe("saved");
    expect(status.firstBot).toBe(true);
    expect(status.scope).toMatch(/^[a-f0-9]{64}$/);
    expect(findPreference).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-a", spaceId: "space-a", isDefault: true }),
      }),
    );
    expect(findBot).toHaveBeenCalledWith({
      where: {
        userId: "user-a",
        spaceId: "space-a",
        OR: [{ spawnKey: "onboarding:first" }, { name: "Chief", spawnKey: null }],
        archivedAt: null,
      },
      select: { id: true },
    });
  });

  it("does not infer a connection from catalog or deployment defaults", async () => {
    const status = await guidedSetupStatus(fixture(false, false).prisma, actor);
    expect(status.model).toBe("missing");
    expect(status.firstBot).toBe(false);
    expect(status.scope).not.toContain(actor.userId);
  });

  it("reports checked only when a real connection check succeeds", async () => {
    const prisma = fixture(true, false).prisma;
    expect((await guidedSetupStatus(prisma, actor, async () => false)).model).toBe("saved");
    expect((await guidedSetupStatus(prisma, actor, async () => true)).model).toBe("checked");
    expect(
      (
        await guidedSetupStatus(prisma, actor, async () => {
          throw new Error("offline");
        })
      ).model,
    ).toBe("saved");
  });

  it("changes scope for another account or selected space", async () => {
    const prisma = fixture(false, false).prisma;
    const original = await guidedSetupStatus(prisma, actor);
    const otherUser = await guidedSetupStatus(prisma, { ...actor, userId: "user-b" });
    const otherSpace = await guidedSetupStatus(prisma, { ...actor, spaceId: "space-b" });
    expect(otherUser.scope).not.toBe(original.scope);
    expect(otherSpace.scope).not.toBe(original.scope);
  });

  it("requires an authenticated actor at the status RPC", async () => {
    const { prisma } = fixture(true, true);
    const handler = new RPCHandler(
      createRouter({ prisma, env: { webOrigin: "http://example.test" } } as RouterDeps),
    );
    const request = new Request("http://example.test/rpc/guidedSetup/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
    });
    const result = await handler.handle(request, {
      prefix: "/rpc",
      context: { actor: null } as never,
    });
    expect(result.response?.status).toBe(401);
  });

  it("returns the account read-back envelope through the authenticated RPC", async () => {
    const { prisma } = fixture(true, true);
    const handler = new RPCHandler(
      createRouter({
        prisma,
        env: { webOrigin: "http://example.test" },
      } as RouterDeps),
    );
    const result = await handler.handle(
      new Request("http://example.test/rpc/guidedSetup/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    expect(result.response?.status).toBe(200);
    const body = await result.response?.json();
    expect(body?.json).toMatchObject({ model: "saved", firstBot: true });
    expect(body?.json.scope).toMatch(/^[a-f0-9]{64}$/);
  });
});
