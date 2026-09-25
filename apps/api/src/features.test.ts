import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "viewer",
  spaceId: "space",
  email: "viewer@example.test",
  isDeploymentOwner: true,
};
function fixture(role: string | null) {
  const membership = vi.fn(async () => (role ? { role } : null));
  const rows = vi.fn(async () => [{ feature: "governance", state: "enabled" }]);
  const write = vi.fn();
  const prisma = {
    spaceMember: { findUnique: membership },
    spaceFeature: { findMany: rows, upsert: write },
  } as unknown as PrismaClient;
  const handler = new RPCHandler(
    createRouter({
      prisma,
      env: { defaultProvider: "fake", defaultModel: "fake" },
    } as unknown as RouterDeps),
  );
  const request = async (path: string, input?: unknown) => {
    const result = await handler.handle(
      new Request(`http://example.test/rpc/features/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return result.response;
  };
  return { request, membership, rows, write };
}
describe("space feature RPCs", () => {
  it.each(["owner", "member"])(
    "lets a %s list build availability without trusting a stored enabled state",
    async (role) => {
      const f = fixture(role);
      const response = await f.request("list");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        json: [{ feature: "governance", state: "unavailable" }],
      });
      expect(f.membership).toHaveBeenCalledWith({
        where: { spaceId_userId: { spaceId: "space", userId: "viewer" } },
      });
      expect(f.rows).toHaveBeenCalledWith({ where: { spaceId: "space" } });
    },
  );
  it("rejects nonmembers before reading feature rows", async () => {
    const f = fixture(null);
    expect((await f.request("list")).status).toBe(403);
    expect(f.rows).not.toHaveBeenCalled();
  });
  it("requires the space owner even for a deployment owner", async () => {
    const f = fixture("member");
    expect((await f.request("set", { feature: "governance", state: "enabled" })).status).toBe(403);
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["enabled", "disabled", "unavailable"])(
    "refuses unavailable governance state changes to %s",
    async (state) => {
      const f = fixture("owner");
      expect((await f.request("set", { feature: "governance", state })).status).toBe(400);
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it("rejects unknown feature names", async () => {
    const f = fixture("owner");
    expect((await f.request("set", { feature: "unknown", state: "enabled" })).status).toBe(400);
    expect(f.write).not.toHaveBeenCalled();
  });
});
