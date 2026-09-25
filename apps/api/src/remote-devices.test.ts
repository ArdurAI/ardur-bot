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
    remoteAuthorityPolicy: {
      findMany: vi.fn(async () => [] as { layer: string; scopes: string[] }[]),
    },
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
  return { app, deps, grant, read, signed, call, tx };
}
describe("isolated device routes", () => {
  it.each(["board/workspaces", "board/snapshot", "board/show", "board/view", "board/work"])(
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
  it.each([
    "pairing/start",
    "integrationSetup/save",
    "actionApprovalRules/create",
    "bots/update",
    "account/updateProfile",
    "account/updateInstructions",
    "account/setTrustedDevices",
    "account/approveDevice",
    "account/disconnectDevice",
    "account/sessions",
    "account/revokeSession",
    "account/revokeOtherSessions",
  ])("blocks permission expansion via %s", async (procedure) => {
    const f = fixture();
    const response = await f.call(f.signed("rpc", { procedure, input: {} }));
    expect(response.status).toBe(403);
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["connectors/summary", "customizationSkills/list", "plugins/list", "integrations/list"])(
    "allows the read-only customization procedure %s",
    async (procedure) => {
      const f = fixture();
      expect((await f.call(f.signed("rpc", { procedure, input: {} }))).status).toBe(200);
      expect(f.read).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "owner", spaceId: "space" }),
        procedure,
        {},
      );
    },
  );
  it.each([
    "customizationSkills/import",
    "plugins/install",
    "developer/apply",
    "extensions/register",
  ])("refuses the customization mutation %s for a read-only phone", async (procedure) => {
    const f = fixture();
    expect((await f.call(f.signed("rpc", { procedure, input: {} }))).status).toBe(403);
    expect(f.read).not.toHaveBeenCalled();
  });
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

describe("space Dispatch switch", () => {
  it.each(["dispatch", "answer", "team-accept", "default"])(
    "blocks signed %s before any work",
    async (operation) => {
      const f = fixture();
      f.grant.scopes = ["dispatch", "steer", "approve", "consequential"];
      f.tx.remoteAuthorityPolicy.findMany.mockResolvedValue([
        { layer: "desktop-dispatch", scopes: [] },
      ]);
      const response = await f.call(
        f.signed(
          operation,
          operation === "dispatch"
            ? { clientNonce: "request", text: "Continue", replyToTaskId: "task" }
            : {},
        ),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Dispatch is off on this computer");
      expect(f.read).not.toHaveBeenCalled();
    },
  );
  it("leaves authenticated reading available while Dispatch is off", async () => {
    const f = fixture();
    f.tx.remoteAuthorityPolicy.findMany.mockResolvedValue([
      { layer: "desktop-dispatch", scopes: [] },
    ]);
    expect(
      (await f.call(f.signed("rpc", { procedure: "threads/get", input: { botId: "bot" } }))).status,
    ).toBe(200);
  });
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

it.each(["runs/list", "team/board", "dashboard/now", "dashboard/connections", "usage/summary"])(
  "allows the read-only Overview procedure %s through a signed read grant",
  async (procedure) => {
    const f = fixture();
    expect((await f.call(f.signed("rpc", { procedure, input: {} }))).status).toBe(200);
    expect(f.read).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: "space", userId: "owner" }),
      procedure,
      {},
    );
  },
);
it("does not expose feature mutation or device management through Overview grants", async () => {
  for (const procedure of ["features/set", "devices/list", "mcp/servers/create"]) {
    const f = fixture();
    expect((await f.call(f.signed("rpc", { procedure, input: {} }))).status).toBe(403);
  }
});
