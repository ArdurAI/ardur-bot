import { generateKeyPairSync, sign } from "node:crypto";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { DeviceProof } from "@ardurbot/contracts";
import { deviceSignedText } from "@ardurbot/contracts";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createRemoteDevices, mountRemoteDevices } from "./remote-devices.js";

function fixture() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const grant = {
    id: "phone",
    instanceId: "home",
    userId: "owner",
    spaceId: "space",
    scopes: ["read"],
    devicePublicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    revokedAt: null as Date | null,
  };
  let nonceUsed = false;
  const tx = {
    instanceIdentity: { findUniqueOrThrow: vi.fn(async () => ({ instanceId: "home" })) },
    deviceGrant: {
      findFirst: vi.fn(async () => (grant.revokedAt ? null : grant)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    spaceMember: { findUnique: vi.fn(async () => ({ id: "member" })) },
    deviceNonce: {
      updateMany: vi.fn(async () => {
        if (nonceUsed) return { count: 0 };
        nonceUsed = true;
        return { count: 1 };
      }),
    },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  const read = vi.fn(async () => ({ threadId: "authorized-thread" }));
  const deps = { prisma, read, events: {} as ThreadEvents, jobs: {} as JobPublisher };
  const app = new Hono();
  mountRemoteDevices(app, deps);
  const signed = (operation: string, body: unknown) => {
    const proof: DeviceProof = {
      grantId: grant.id,
      nonce: "n".repeat(43),
      timestamp: Date.now(),
      signature: "",
    };
    proof.signature = sign(
      "sha256",
      Buffer.from(deviceSignedText("home", proof, operation, body)),
      keys.privateKey,
    ).toString("base64");
    return { operation, body, proof };
  };
  const call = (body: unknown) =>
    app.request("/device/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, deps, grant, read, signed, call };
}
describe("isolated device routes", () => {
  it.each(["board/workspaces", "board/snapshot", "board/show"])(
    "allows the signed read-only Board procedure %s",
    async (procedure) => {
      const f = fixture();
      expect(
        (await f.call(f.signed("rpc", { procedure, input: { workspaceId: "workspace" } }))).status,
      ).toBe(200);
      expect(f.read).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "owner", spaceId: "space" }),
        procedure,
        { workspaceId: "workspace" },
      );
    },
  );
  it.each([
    "board/create",
    "board/update",
    "board/claim",
    "board/close",
    "board/comment",
    "board/link",
    "board/start",
    "board/send",
    "board/export",
  ])("refuses Board writes from a read-only phone: %s", async (procedure) => {
    const f = fixture();
    expect((await f.call(f.signed("rpc", { procedure, input: {} }))).status).toBe(403);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("reads the same user and space thread through a signed grant", async () => {
    const f = fixture();
    const response = await f.call(
      f.signed("rpc", { procedure: "threads/get", input: { botId: "bot" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threadId: "authorized-thread" });
    expect(f.read).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner", spaceId: "space" }),
      "threads/get",
      { botId: "bot" },
    );
  });
  it.each(["pairing/start", "integrationSetup/save", "actionApprovalRules/create", "bots/update"])(
    "blocks permission expansion via %s",
    async (procedure) => {
      const f = fixture();
      const response = await f.call(f.signed("rpc", { procedure, input: {} }));
      expect(response.status).toBe(403);
      expect(f.read).not.toHaveBeenCalled();
    },
  );
  it("rejects a revoked device on its next request", async () => {
    const f = fixture();
    f.grant.revokedAt = new Date();
    expect((await f.call(f.signed("rpc", { procedure: "me", input: {} }))).status).toBe(401);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("requires the home owner to start pairing", async () => {
    const f = fixture();
    await expect(
      createRemoteDevices(f.deps).start(
        { userId: "owner", spaceId: "space", email: "test@example.test", isDeploymentOwner: false },
        { scopes: ["read"], hints: [] },
      ),
    ).rejects.toThrow("home owner");
  });
});

it("allows signed Team reads but refuses task controls without their scopes", async () => {
  const f = fixture();
  expect((await f.call(f.signed("rpc", { procedure: "team/board", input: {} }))).status).toBe(200);
  for (const operation of ["team-stop", "team-accept"]) {
    const reader = fixture();
    expect(
      (await reader.call(reader.signed(operation, { id: "handoff", rootTaskId: "root" }))).status,
    ).toBe(403);
  }
});

it("exposes read-only comparison views to signed readers", async () => {
  for (const procedure of ["comparisons/list", "comparisons/get"]) {
    const f = fixture();
    expect((await f.call(f.signed("rpc", { procedure, input: { id: "comparison" } }))).status).toBe(
      200,
    );
  }
  for (const procedure of ["comparisons/create", "comparisons/merge"]) {
    const f = fixture();
    expect((await f.call(f.signed("rpc", { procedure, input: {} }))).status).not.toBe(200);
    expect(f.read).not.toHaveBeenCalled();
  }
});
