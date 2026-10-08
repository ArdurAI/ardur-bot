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
  const usedNonces = new Set<string>();
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
      updateMany: vi.fn(async ({ where }) => {
        if (usedNonces.has(where.hash)) return { count: 0 };
        usedNonces.add(where.hash);
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
      nonce: crypto.randomUUID().replaceAll("-", "").padEnd(43, "n"),
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

function scopedFixture() {
  const f = fixture();
  const receipts = Array.from({ length: 101 }, (_, index) => ({
    id: `receipt-${index}`,
    instanceId: "home",
    spaceId: "space",
    deviceGrantId: "phone",
    taskId: `task-${index}`,
    runId: `run-${index}`,
    botId: "bot",
    threadId: "thread",
    createdAt: new Date(index * 1000),
  }));
  const runs = receipts.map((receipt) => ({
    id: receipt.runId,
    taskId: receipt.taskId,
    botId: receipt.botId,
    threadId: receipt.threadId,
    spaceId: "space",
    userId: "owner",
    status: "queued",
    createdAt: receipt.createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelConfirmedAt: null,
    providerErrorKind: null,
    error: null,
    runtimeProblem: null,
  }));
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) =>
      typeof value === "object" ? true : row[key] === value,
    );
  Object.assign(f.tx, {
    dispatchReceipt: {
      findFirst: vi.fn(async ({ where }) => receipts.find((row) => matches(row, where)) ?? null),
      findMany: vi.fn(async () => receipts.slice(-100).reverse()),
    },
    run: {
      findFirst: vi.fn(async ({ where }) => runs.find((row) => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where }) => runs.filter((row) => where.id.in.includes(row.id))),
    },
    event: {
      findFirst: vi.fn(async () => ({
        payload: { error: "private", providerErrorKind: runs[0]!.providerErrorKind },
      })),
    },
    dispatchSummary: { findFirst: vi.fn(async () => ({ messageId: "answer" })) },
    thread: {
      findFirst: vi.fn(async ({ where }) =>
        matches(
          {
            id: "thread",
            botId: "bot",
            groupId: null,
            userId: "owner",
            spaceId: "space",
          },
          where,
        )
          ? { id: "thread" }
          : null,
      ),
    },
    $queryRaw: vi.fn(async () => [...runs].reverse().slice(0, 3)),
  });
  Object.assign(f.deps.prisma, f.tx);
  return { ...f, runs, receipts };
}
const newReads = [
  ["runs/get", { runId: "run-0" }],
  ["tasks/get", { taskId: "task-0" }],
  ["runs/list", { cursor: "run-0", limit: 2 }],
  ["messages/get", { threadId: "thread", botId: "bot" }],
] as const;
it("finds the old task by exact id after the existing list overflows", async () => {
  const f = scopedFixture();
  const listed = await f.call(f.signed("tasks", {}));
  const list = (await listed.json()) as Array<{ taskId: string }>;
  expect(list).toHaveLength(100);
  expect(list.some((row) => row.taskId === "task-0")).toBe(false);
  const exact = await f.call(f.signed("tasks/get", { taskId: "task-0" }));
  expect(exact.status).toBe(200);
  expect(await exact.json()).toMatchObject({
    task: { taskId: "task-0", status: "queued", state: "accepted" },
  });
});
it.each(newReads)("refuses revoked grants before %s reads", async (operation, body) => {
  const f = scopedFixture();
  f.grant.revokedAt = new Date();
  expect((await f.call(f.signed(operation, body))).status).toBe(401);
  expect(f.read).not.toHaveBeenCalled();
});
it.each(newReads)("requires read scope for %s", async (operation, body) => {
  const f = scopedFixture();
  f.grant.scopes = [];
  expect((await f.call(f.signed(operation, body))).status).toBe(403);
});
it.each(newReads)("refuses removed membership for %s", async (operation, body) => {
  const f = scopedFixture();
  f.tx.spaceMember.findUnique.mockResolvedValue(null as never);
  expect((await f.call(f.signed(operation, body))).status).toBe(401);
});
for (const boundary of ["user", "space", "device"]) {
  it.each(
    boundary === "device"
      ? newReads.filter(([operation]) => operation !== "messages/get")
      : newReads,
  )(`refuses cross-${boundary} access for %s`, async (operation, body) => {
    const f = scopedFixture();
    if (boundary === "user") f.grant.userId = "other-user";
    if (boundary === "space") f.grant.spaceId = "other-space";
    if (boundary === "device") {
      f.grant.id = "other-device";
    }
    const response = await f.call(f.signed(operation, body));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: "This record is unavailable from this device.",
    });
    expect(f.read).not.toHaveBeenCalled();
  });
}
it.each(["runs/get", "tasks/get"])(
  "does not reveal foreign versus missing ids for %s",
  async (operation) => {
    const f = scopedFixture();
    const body = operation === "runs/get" ? { runId: "unknown" } : { taskId: "unknown" };
    const response = await f.call(f.signed(operation, body));
    expect(await response.json()).toEqual({
      message: "This record is unavailable from this device.",
    });
  },
);
it("keeps raw waiting status and cancellation request separate from confirmed stop", async () => {
  const f = scopedFixture();
  f.runs[0]!.status = "waiting_input";
  f.runs[0]!.cancelRequestedAt = new Date() as never;
  const first = await f.call(f.signed("runs/get", { runId: "run-0" }));
  expect(await first.json()).toMatchObject({
    run: {
      status: "waiting_input",
      state: "running",
      cancelRequested: true,
      cancelConfirmed: false,
    },
  });
  f.runs[0]!.status = "cancelled";
  f.runs[0]!.cancelConfirmedAt = new Date() as never;
  const second = await f.call(f.signed("runs/get", { runId: "run-0" }));
  expect(await second.json()).toMatchObject({
    run: { status: "cancelled", state: "stopped", cancelConfirmed: true },
  });
});
it.each(["auth", "rate-limit", "model-unavailable", null])(
  "projects safe provider category for %s",
  async (kind) => {
    const f = scopedFixture();
    f.runs[0]!.status = "failed";
    f.runs[0]!.providerErrorKind = kind as never;
    f.runs[0]!.error = "private provider diagnostic /private/file" as never;
    const response = await f.call(f.signed("runs/get", { runId: "run-0" }));
    const output = await response.text();
    expect(output).not.toContain("private");
    expect(JSON.parse(output).run.failure.category).toBe(
      kind === "auth"
        ? "signed-out"
        : kind === "rate-limit"
          ? "usage-limit"
          : kind === "model-unavailable"
            ? "model-unavailable"
            : "other",
    );
  },
);
it("routes message reads through the same bounded redacted projection", async () => {
  const f = scopedFixture();
  const response = await f.call(
    f.signed("messages/get", { botId: "bot", threadId: "thread", before: 9 }),
  );
  expect(response.status).toBe(200);
  expect(f.read).toHaveBeenCalledWith(f.grant, "threads/messages", {
    botId: "bot",
    threadId: "thread",
    before: 9,
  });
});
it("bounds pages and returns the last delivered run as the next cursor", async () => {
  const f = scopedFixture();
  const response = await f.call(f.signed("runs/list", { limit: 2 }));
  expect(await response.json()).toMatchObject({
    runs: [{ runId: "run-100" }, { runId: "run-99" }],
    nextCursor: "run-99",
  });
  expect((await f.call(f.signed("runs/list", { limit: 101 }))).status).toBe(400);
});
