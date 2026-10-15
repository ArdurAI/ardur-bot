import { generateKeyPairSync, sign } from "node:crypto";
import { currentRemoteDecision } from "@ardurbot/adapters";
import type { DeviceRoomSendInput } from "@ardurbot/contracts";
import { ALL_DEVICE_SCOPES, deviceSignedText } from "@ardurbot/contracts";
import type { DeviceGrant, PrismaClient } from "@ardurbot/db";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { sendDeviceRoom } from "./device-rooms.js";
import { mountRemoteDevices } from "./remote-devices.js";

function fixture() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const grant = {
    devicePublicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    id: "device",
    instanceId: "home",
    userId: "owner",
    spaceId: "space",
    scopes: [...ALL_DEVICE_SCOPES],
    kind: "device",
    trustedAt: new Date(),
    revokedAt: null,
  } as DeviceGrant;
  const members = ["Chief", "Beta", "Gamma"].map((name) => ({
    bot: { id: name.toLowerCase(), name, color: null, runs: [] },
  }));
  const group = {
    id: "room",
    name: "Room",
    spaceId: "space",
    userId: "owner",
    archivedAt: null,
    coordinatorBotId: "chief",
    thread: { id: "thread", runs: [] },
    members,
    space: { coordinatorBotId: null },
  };
  const messages: Array<Record<string, any>> = [];
  const runs: Array<Record<string, any>> = [];
  const receipts: Array<Record<string, any>> = [];
  const events: Array<Record<string, any>> = [];
  let seq = 0;
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "room" }]),
    deviceGrant: {
      findFirst: vi.fn(async ({ where }) =>
        grant.revokedAt ||
        Object.entries(where).some(([key, value]) => grant[key as keyof DeviceGrant] !== value)
          ? null
          : grant,
      ),
      findUnique: vi.fn(async () => grant),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    deviceNonce: { updateMany: vi.fn(async () => ({ count: 1 })) },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    spaceMember: {
      findFirst: vi.fn(async () => ({
        userId: "owner",
        spaceId: "space",
        member: { user: { email: "fixture@example.test" } },
      })),
      findUnique: vi.fn(async () => ({ id: "member" })),
    },
    instanceIdentity: {
      findUnique: vi.fn(async () => ({ instanceId: "home", scopes: ALL_DEVICE_SCOPES })),
      findUniqueOrThrow: vi.fn(async () => ({ instanceId: "home", scopes: ALL_DEVICE_SCOPES })),
    },
    remoteAuthorityPolicy: {
      findMany: vi.fn(async () => [] as Array<{ layer: string; scopes: string[] }>),
    },
    space: { findUnique: vi.fn(async () => ({ coordinatorBotId: null })) },
    chatGroup: {
      findMany: vi.fn(async () => [{ id: "room" }]),
      findFirst: vi.fn(async ({ where }) =>
        where.id === "room" && where.spaceId === "space" && where.userId === "owner" ? group : null,
      ),
      findUnique: vi.fn(async () => group),
      update: vi.fn(),
    },
    bot: {
      findFirst: vi.fn(async ({ where }) =>
        where.userId === "owner" && where.spaceId === "space" ? { id: where.id } : null,
      ),
      findMany: vi.fn(async () => []),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: ++seq, nextEventSeq: seq })) },
    message: {
      findUnique: vi.fn(async ({ where }) => {
        const message = messages.find(
          (row) => row.clientNonce === where.threadId_clientNonce.clientNonce,
        );
        return message
          ? { ...message, sourceRuns: runs.filter((run) => run.sourceMessageId === message.id) }
          : null;
      }),
      create: vi.fn(async ({ data }) => {
        const message = { ...data, id: `message-${messages.length}`, seq, createdAt: new Date() };
        messages.push(message);
        return message;
      }),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(messages.find((row) => row.id === where.id)!, data),
      ),
    },
    run: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async ({ where }) =>
        where.id ? (runs.find((row) => row.id === where.id) ?? null) : null,
      ),
      findUnique: vi.fn(async ({ where }) => runs.find((row) => row.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }) =>
        where.id?.in ? runs.filter((run) => where.id.in.includes(run.id)) : [],
      ),
      create: vi.fn(async ({ data }) => {
        const run = {
          ...data,
          id: `run-${runs.length}`,
          remoteDeviceGrantIds: [],
          originDeviceGrantId: null,
          remoteRootTaskId: null,
        };
        runs.push(run);
        return run;
      }),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(runs.find((row) => row.id === where.id)!, data),
      ),
    },
    task: { create: vi.fn(async ({ data }) => ({ ...data, id: `task-${runs.length}` })) },
    dispatchReceipt: {
      create: vi.fn(async ({ data }) => {
        receipts.push(data);
        return data;
      }),
      findMany: vi.fn(async () => receipts),
    },
    deviceAuditEvent: { create: vi.fn() },
    event: {
      create: vi.fn(async ({ data }) => {
        const event = { ...data, seq };
        events.push(event);
        return event;
      }),
      findFirst: vi.fn(async ({ where }) =>
        where.type ? events.find((row) => row.payload.messageId === where.payload.equals) : { seq },
      ),
    },
    steeringMessage: { create: vi.fn() },
    chiefPlan: { create: vi.fn(async () => ({ id: "plan", revision: 1 })) },
    chiefAssignment: { upsert: vi.fn() },
    mcpServer: { findMany: vi.fn(async () => []) },
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    botBrief: { findMany: vi.fn(async () => []) },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn) => {
      const saved = structuredClone({ messages, runs, receipts, events, seq });
      try {
        return await fn(tx);
      } catch (error) {
        messages.splice(0, messages.length, ...saved.messages);
        runs.splice(0, runs.length, ...saved.runs);
        receipts.splice(0, receipts.length, ...saved.receipts);
        events.splice(0, events.length, ...saved.events);
        seq = saved.seq;
        throw error;
      }
    }),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    jobs: { enqueue: vi.fn(async () => undefined) } as never,
    events: { notify: vi.fn(async () => undefined) } as never,
  };
  const input: DeviceRoomSendInput = {
    groupId: "room",
    clientNonce: "fixture-room-request-1",
    text: "@Beta @Gamma compare notes",
  };
  const app = new Hono();
  mountRemoteDevices(app, { ...deps, read: vi.fn(async () => []) });
  const request = (body: DeviceRoomSendInput) => {
    const proof = {
      grantId: grant.id,
      nonce: "n".repeat(43),
      timestamp: Date.now(),
      signature: "",
    };
    proof.signature = sign(
      "sha256",
      Buffer.from(deviceSignedText("home", proof, "rooms/send", body)),
      keys.privateKey,
    ).toString("base64");
    return app.request("/device/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proof, operation: "rooms/send", body }),
    });
  };
  return { deps, grant, tx, group, input, runs, receipts, messages, request };
}

it("preserves every room run id and binds every routed bot to the device receipt and authority", async () => {
  const f = fixture();
  const result = await sendDeviceRoom(f.deps, f.grant, f.input);
  expect(result).toMatchObject({ kind: "work", runIds: ["run-0", "run-1"] });
  expect(f.runs.map((run) => run.botId)).toEqual(["beta", "gamma"]);
  expect(f.receipts).toHaveLength(2);
  for (const run of f.runs)
    expect(run).toMatchObject({
      originDeviceGrantId: "device",
      remoteDeviceGrantIds: ["device"],
      remoteRootTaskId: run.taskId,
    });
  expect(f.tx.bot.findFirst.mock.calls.map(([arg]) => arg.where.id)).toContain("gamma");
});
it("returns and replays a receipt-only greeting without creating a run", async () => {
  const f = fixture();
  f.input.text = "hello";
  const result = await sendDeviceRoom(f.deps, f.grant, f.input);
  expect(result).toMatchObject({
    kind: "receipt-only",
    receipt: { key: "greeting", threadId: "thread" },
  });
  expect(result).not.toHaveProperty("runId");
  expect(await sendDeviceRoom(f.deps, f.grant, f.input)).toEqual(result);
  expect(f.runs).toHaveLength(0);
  expect(f.messages).toHaveLength(2);
});
it("replays multiple runs and refuses a changed body with the same request id", async () => {
  const f = fixture();
  const result = await sendDeviceRoom(f.deps, f.grant, f.input);
  expect(await sendDeviceRoom(f.deps, f.grant, f.input)).toEqual(result);
  expect(f.runs).toHaveLength(2);
  await expect(
    sendDeviceRoom(f.deps, f.grant, { ...f.input, text: "different" }),
  ).rejects.toMatchObject({ status: 409 });
});
it("refuses ambiguous room names within the device's owner and space", async () => {
  const f = fixture();
  f.tx.chatGroup.findMany.mockResolvedValue([{ id: "room" }, { id: "duplicate" }]);
  await expect(
    sendDeviceRoom(f.deps, f.grant, {
      roomName: "Room",
      clientNonce: f.input.clientNonce,
      text: "hello",
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(f.tx.chatGroup.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ spaceId: "space", userId: "owner", archivedAt: null }),
      take: 2,
    }),
  );
  expect(f.tx.message.create).not.toHaveBeenCalled();
});
it("resolves room name inside the device verification transaction", async () => {
  const f = fixture();
  let inVerificationTransaction = false;
  let resolvedInsideTransaction = false;
  const originalTx = f.deps.prisma.$transaction;
  (f.deps.prisma as any).$transaction = vi.fn(async (fn: any) => {
    inVerificationTransaction = true;
    try {
      return await originalTx(fn);
    } finally {
      inVerificationTransaction = false;
    }
  });
  f.tx.chatGroup.findMany.mockImplementation(async () => {
    if (inVerificationTransaction) resolvedInsideTransaction = true;
    return [{ id: "room" }];
  });
  await sendDeviceRoom(f.deps, f.grant, {
    roomName: "Room",
    clientNonce: f.input.clientNonce,
    text: "hello",
  });
  expect(resolvedInsideTransaction).toBe(true);
});
it.each([{ groupId: "foreign" }, { groupId: "room", threadId: "foreign-thread" }])(
  "refuses unauthorized room/thread %j",
  async (target) => {
    const f = fixture();
    await expect(sendDeviceRoom(f.deps, f.grant, { ...f.input, ...target })).rejects.toThrow();
    expect(f.tx.message.create).not.toHaveBeenCalled();
  },
);
it.each(["dispatch", "ordinary"])(
  "requires current %s scope on every admission and replay",
  async (scope) => {
    const f = fixture();
    await sendDeviceRoom(f.deps, f.grant, f.input);
    f.grant.scopes = f.grant.scopes.filter((value) => value !== scope);
    await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
    expect(f.runs).toHaveLength(2);
  },
);
it("refuses when one routed bot's authority is denied, including replay", async () => {
  const f = fixture();
  await sendDeviceRoom(f.deps, f.grant, f.input);
  f.tx.bot.findFirst.mockImplementation(async ({ where }) =>
    where.id === "gamma" ? null : { id: where.id },
  );
  await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
});
it("checks ownership again after room publication and refuses a revoked device", async () => {
  const f = fixture();
  vi.mocked(f.deps.events.notify).mockImplementation(async () => {
    f.grant.revokedAt = new Date();
  });
  await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
  expect(f.runs).toHaveLength(2);
  for (const run of f.runs)
    await expect(currentRemoteDecision(f.deps.prisma, run.id, "file_read")).resolves.toMatchObject({
      allowed: false,
      kind: "authority",
    });
});
it("refuses an owner change before admission", async () => {
  const f = fixture();
  f.tx.deploymentSettings.findUnique.mockResolvedValue({ ownerUserId: "another-owner" });
  await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
  expect(f.tx.message.create).not.toHaveBeenCalled();
});

it("returns multiple run ids through the authenticated signed room operation", async () => {
  const f = fixture();
  const response = await f.request(f.input);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ kind: "work", runIds: ["run-0", "run-1"] });
});
it("returns a receipt-only response through the signed room operation", async () => {
  const f = fixture();
  f.input.text = "hello";
  const response = await f.request(f.input);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ kind: "receipt-only", receipt: { key: "greeting" } });
  expect(body).not.toHaveProperty("runId");
});
it("resolves one room name using the same target as a room id", async () => {
  const f = fixture();
  const { groupId: _groupId, ...rest } = f.input;
  expect(await sendDeviceRoom(f.deps, f.grant, { ...rest, roomName: "room" })).toMatchObject({
    kind: "work",
    runIds: ["run-0", "run-1"],
  });
});

it("checks a later routed bot's live policy before creating any room message or run", async () => {
  const f = fixture();
  f.tx.remoteAuthorityPolicy.findMany.mockImplementation(async ({ where }) =>
    where.OR?.some((entry) => entry.layer === "bot" && entry.subjectId === "gamma")
      ? [{ layer: "bot", scopes: ["dispatch"] }]
      : [],
  );
  await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
  expect(f.tx.message.create).not.toHaveBeenCalled();
  expect(f.tx.run.create).not.toHaveBeenCalled();
});
it("requires steer for existing runs and preserves the original device ceiling", async () => {
  const f = fixture();
  await sendDeviceRoom(f.deps, f.grant, f.input);
  f.tx.run.findMany.mockImplementation(async ({ where }) =>
    where.id?.in
      ? f.runs.filter((run) => where.id.in.includes(run.id))
      : where.status
        ? f.runs
        : [],
  );
  for (const run of f.runs) {
    run.originDeviceGrantId = "original-device";
    run.remoteDeviceGrantIds = ["original-device"];
  }
  f.grant.scopes = f.grant.scopes.filter((scope) => scope !== "steer");
  const next = { ...f.input, clientNonce: "fixture-room-request-2" };
  await expect(sendDeviceRoom(f.deps, f.grant, next)).rejects.toMatchObject({ status: 403 });
  f.grant.scopes.push("steer");
  expect(
    await sendDeviceRoom(f.deps, f.grant, { ...next, clientNonce: "fixture-room-request-3" }),
  ).toMatchObject({ runIds: ["run-0", "run-1"] });
  for (const run of f.runs)
    expect(run).toMatchObject({
      originDeviceGrantId: "original-device",
      remoteDeviceGrantIds: ["original-device", "device"],
    });
});
it("preserves exact retry text even though room display text is trimmed", async () => {
  const f = fixture();
  f.input.text = " hello ";
  const result = await sendDeviceRoom(f.deps, f.grant, f.input);
  expect(await sendDeviceRoom(f.deps, f.grant, f.input)).toEqual(result);
  await expect(
    sendDeviceRoom(f.deps, f.grant, { ...f.input, text: "hello" }),
  ).rejects.toMatchObject({ status: 409 });
});

it("keeps the existing device active-run limit for room admission", async () => {
  const f = fixture();
  f.tx.run.count.mockResolvedValue(20);
  await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 429 });
  expect(f.runs).toHaveLength(0);
  expect(f.messages).toHaveLength(0);
  expect(f.receipts).toHaveLength(0);
});
