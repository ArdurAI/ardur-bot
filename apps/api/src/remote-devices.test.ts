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
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    botCommunicationPolicy: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
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
  it("allows an owner policy read and requires stop scope and owner identity for pause", async () => {
    const read = fixture();
    const policy = await read.call(read.signed("team-policy", {}));
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ scope: "space", paused: false });
    const noScope = fixture();
    expect(
      (await noScope.call(noScope.signed("team-pause", { scope: "space", expectedRevision: 1 })))
        .status,
    ).toBe(403);
    const nonOwner = fixture();
    nonOwner.grant.scopes.push("stop");
    nonOwner.tx.deploymentSettings.findUnique.mockResolvedValue({ ownerUserId: "another-user" });
    expect(
      (await nonOwner.call(nonOwner.signed("team-pause", { scope: "space", expectedRevision: 1 })))
        .status,
    ).toBe(403);
  });
  it("rejects owner pause when current space authority has removed Stop", async () => {
    const f = fixture();
    f.grant.scopes.push("stop");
    Object.assign(f.tx, {
      $queryRaw: vi.fn(async () => [{ id: f.grant.id }]),
      instanceIdentity: {
        ...f.tx.instanceIdentity,
        findUnique: vi.fn(async () => ({ instanceId: "home", scopes: ["read", "stop"] })),
      },
      bot: {
        findMany: vi.fn(async () => [{ id: "worker" }]),
        findFirst: vi.fn(async () => ({ id: "worker" })),
      },
    });
    f.tx.remoteAuthorityPolicy.findMany.mockResolvedValue([{ layer: "space", scopes: ["read"] }]);
    const response = await f.call(f.signed("team-pause", { scope: "space", expectedRevision: 1 }));
    expect(response.status).toBe(403);
    expect(f.tx.botCommunicationPolicy.findMany).not.toHaveBeenCalled();
  });
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
    "groups/setMemberModelPin",
    "groups/clearMemberModelPin",
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

function headlessFixture(enabled = false) {
  const home = {
    instanceId: "fixture-home",
    homeName: "Fixture home",
    fingerprint: "a".repeat(64),
    certificateFingerprint: "b".repeat(64),
    scopes: ["read"],
  };
  const tx = {
    pairingChallenge: { create: vi.fn(async () => ({})) },
    deviceAuditEvent: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    instanceIdentity: { findUniqueOrThrow: vi.fn(async () => home) },
    deviceGrant: { findMany: vi.fn(async () => []) },
    pendingDevicePairing: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn) => fn(tx)),
  } as unknown as PrismaClient;
  const server = { enabled, hints: enabled ? ["https://home.example.test:43119"] : [] };
  const trustedDesktopHints = vi.fn(() => [] as string[]);
  const service = createRemoteDevices({
    prisma,
    events: {} as ThreadEvents,
    jobs: {} as JobPublisher,
    listenerState: () => server,
    trustedDesktopHints,
  });
  const actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  return { service, actor, server, trustedDesktopHints, prisma, tx, home };
}
it("gives the headless owner no listener or usable pairing payload when disabled", async () => {
  const f = headlessFixture();
  expect((await f.service.list(f.actor)).listener).toEqual({ enabled: false, hints: [] });
  await expect(
    f.service.start(f.actor, { scopes: ["read"], hints: ["https://unapproved.example.test"] }),
  ).rejects.toThrow("ARDURBOT_DEVICE_LISTENER_ENABLED");
  expect(f.tx.pairingChallenge.create).not.toHaveBeenCalled();
});
it("puts the approved pinned server origin first and ignores browser hints and the web origin", async () => {
  const f = headlessFixture(true);
  f.trustedDesktopHints.mockReturnValue(["https://10.0.0.2:43119", f.server.hints[0]!]);
  const issued = await f.service.start(f.actor, {
    scopes: ["read"],
    hints: ["https://web.example.test", "https://unapproved.example.test"],
  });
  expect(issued.payload.hints).toEqual([f.server.hints[0], "https://10.0.0.2:43119"]);
  expect(issued.payload.certificateFingerprint).toBe(f.home.certificateFingerprint);
  expect(issued.payload.instanceId).toBe(f.home.instanceId);
  expect(JSON.stringify(await f.service.list(f.actor))).not.toMatch(/privateKey|ciphertext/);
});
it("retains trusted desktop-only pairing without accepting browser-selected origins", async () => {
  const f = headlessFixture();
  f.trustedDesktopHints.mockReturnValue(["https://10.0.0.2:43119"]);
  expect((await f.service.start(f.actor, { scopes: ["read"], hints: [] })).payload.hints).toEqual([
    "https://10.0.0.2:43119",
  ]);
});
it("refuses non-owner listener state before reading the home identity", async () => {
  const f = headlessFixture(true);
  await expect(f.service.list({ ...f.actor, isDeploymentOwner: false })).rejects.toThrow(
    "home owner",
  );
  expect(f.prisma.instanceIdentity.findUniqueOrThrow).not.toHaveBeenCalled();
});
