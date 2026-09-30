import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { createEvidenceStore } from "@ardurbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import { createEvidenceRecorder } from "../../../packages/adapters/src/evidence/recorder.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  userId: "viewer",
  spaceId: "space",
  email: "viewer@example.test",
  isDeploymentOwner: true,
};
function fixture(role: string | null, stored: { feature: string; state: string }[] = []) {
  const membership = vi.fn(async () => (role ? { role } : null));
  const rows = vi.fn(async () => stored);
  const write = vi.fn();
  const prisma = {
    spaceMember: { findUnique: membership },
    spaceFeature: {
      findMany: rows,
      findUnique: vi.fn(async () => stored[0] ?? null),
      upsert: write,
    },
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
    if (!result.response) throw new Error("RPC was not matched");
    return result.response;
  };
  return { request, membership, rows, write, prisma };
}
describe("space feature RPCs", () => {
  it.each(["owner", "member"])("lets a %s list governance, disabled with no row", async (role) => {
    const f = fixture(role);
    const response = await f.request("list");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      json: [{ feature: "governance", state: "disabled", canManage: role === "owner" }],
    });
    expect(f.membership).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: "space", userId: "viewer" } },
    });
    expect(f.rows).toHaveBeenCalledWith({ where: { spaceId: "space" } });
  });
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
  it.each(["enabled", "disabled"])(
    "allows only an owner to set governance to %s",
    async (state) => {
      const f = fixture("owner");
      expect((await f.request("set", { feature: "governance", state })).status).toBe(200);
      expect(f.write).toHaveBeenCalledWith({
        where: { spaceId_feature: { spaceId: "space", feature: "governance" } },
        create: { spaceId: "space", feature: "governance", state },
        update: { state },
      });
    },
  );
  it.each([{ stored: [] }, { stored: [{ feature: "governance", state: "disabled" }] }])(
    "keeps recording off unless explicitly enabled: %j",
    async ({ stored }) => {
      const f = fixture("owner", stored);
      expect(await createEvidenceStore(f.prisma).governanceEnabled("space")).toBe(false);
      const store = createEvidenceStore(f.prisma);
      const insert = vi.spyOn(store, "insertRecord");
      const put = vi.fn();
      const recorder = createEvidenceRecorder({ store, secretStore: { put, load: vi.fn() } });
      await recorder.recordDecision({
        run: { id: "run", spaceId: "space", userId: "viewer", botId: "bot" },
        toolName: "read_file",
        viaConnector: false,
        args: { path: "example.txt" },
        decisionKind: "allowed_by_default",
      });
      expect(insert).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it("reads an explicitly enabled row", async () => {
    const f = fixture("member", [{ feature: "governance", state: "enabled" }]);
    expect(await (await f.request("list")).json()).toEqual({
      json: [{ feature: "governance", state: "enabled", canManage: false }],
    });
  });
  it("rejects unavailable as a writable state", async () => {
    const f = fixture("owner");
    expect((await f.request("set", { feature: "governance", state: "unavailable" })).status).toBe(
      400,
    );
    expect(f.write).not.toHaveBeenCalled();
  });
  it("rejects unknown feature names", async () => {
    const f = fixture("owner");
    expect((await f.request("set", { feature: "unknown", state: "enabled" })).status).toBe(400);
    expect(f.write).not.toHaveBeenCalled();
  });
});
