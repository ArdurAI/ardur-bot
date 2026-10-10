import { randomUUID } from "node:crypto";
import { currentRemoteDecision } from "@ardurbot/adapters";
import type { DeviceRoomSendInput } from "@ardurbot/contracts";
import { ALL_DEVICE_SCOPES } from "@ardurbot/contracts";
import { createDb, persistDispatchSummary, provisionMessagingIdentity } from "@ardurbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sendDeviceRoom } from "../../../apps/api/src/device-rooms.js";
import { getDeviceRun } from "../../../apps/api/src/device-runs.js";

const enabled =
  process.env.CI === "1" &&
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL);
// The integration harness gives this suite its own disposable database. No worker or computer runs.
describe.skipIf(!enabled).sequential("Stage 4 home room admission", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function fixture() {
    const mine = await provisionMessagingIdentity(
      db.prisma,
      { provider: "sendblue", address: `fixture-${randomUUID()}` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const scope = { userId: mine.userId, spaceId: mine.spaceId };
    await db.prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { ownerUserId: mine.userId },
      update: { ownerUserId: mine.userId },
    });
    const home = await db.prisma.instanceIdentity.upsert({
      where: { id: "home" },
      update: { scopes: ALL_DEVICE_SCOPES },
      create: {
        instanceId: "fixture-home",
        publicKey: "fixture-public-key",
        fingerprint: "a".repeat(64),
        certificate: "fixture-certificate",
        certificateFingerprint: "b".repeat(64),
        privateKeyCiphertext: "fixture-unusable",
        scopes: ALL_DEVICE_SCOPES,
      },
    });
    const chief = await db.prisma.bot.findUniqueOrThrow({ where: { id: mine.botId } });
    await db.prisma.bot.update({ where: { id: chief.id }, data: { name: "Chief" } });
    const bots = await Promise.all(
      ["Beta", "Gamma"].map((name) =>
        db.prisma.bot.create({ data: { ...scope, name, color: chief.color } }),
      ),
    );
    const group = await db.prisma.chatGroup.create({
      data: {
        ...scope,
        name: "Fixture room",
        coordinatorBotId: chief.id,
        members: { create: [chief, ...bots].map((bot) => ({ botId: bot.id })) },
        thread: { create: scope },
      },
      include: { thread: true },
    });
    const grant = await db.prisma.deviceGrant.create({
      data: {
        ...scope,
        instanceId: home.instanceId,
        deviceName: "Fixture device",
        devicePublicKey: "fixture-public-key",
        presencePublicKey: "fixture-presence-key",
        scopes: ALL_DEVICE_SCOPES,
      },
    });
    const deps = {
      prisma: db.prisma,
      events: { notify: vi.fn(async () => undefined) } as never,
      jobs: { enqueue: vi.fn(async () => undefined) } as never,
    };
    const input: DeviceRoomSendInput = {
      groupId: group.id,
      clientNonce: randomUUID(),
      text: "@Beta @Gamma compare notes",
    };
    return { scope, group, bots, chief, grant, deps, input };
  }
  it("atomically admits and concurrently replays all routed room runs with per-device receipts", async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([
      sendDeviceRoom(f.deps, f.grant, f.input),
      sendDeviceRoom(f.deps, f.grant, f.input),
    ]);
    expect(second).toEqual(first);
    if (first.kind === "receipt-only") throw new Error("Expected room work");
    expect(first.runIds).toHaveLength(2);
    const receipts = await db.prisma.dispatchReceipt.findMany({
      where: { deviceGrantId: f.grant.id },
    });
    expect(receipts.map((row) => row.runId).sort()).toEqual([...first.runIds!].sort());
    const runs = await db.prisma.run.findMany({ where: { id: { in: first.runIds } } });
    expect(runs).toHaveLength(2);
    for (const run of runs)
      expect(run).toMatchObject({
        ...f.scope,
        originDeviceGrantId: f.grant.id,
        remoteDeviceGrantIds: [f.grant.id],
        remoteRootTaskId: run.taskId,
      });
    await expect(
      sendDeviceRoom(f.deps, f.grant, { ...f.input, text: "changed" }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back the message, tasks and every run if one room bot denies ordinary authority", async () => {
    const f = await fixture();
    await db.prisma.remoteAuthorityPolicy.create({
      data: { layer: "bot", subjectId: f.bots[1]!.id, scopes: ["dispatch"] },
    });
    await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
    expect(await db.prisma.message.count({ where: { threadId: f.group.thread!.id } })).toBe(0);
    expect(await db.prisma.run.count({ where: { threadId: f.group.thread!.id } })).toBe(0);
    expect(await db.prisma.task.count({ where: { threadId: f.group.thread!.id } })).toBe(0);
    expect(await db.prisma.dispatchReceipt.count({ where: { deviceGrantId: f.grant.id } })).toBe(0);
  });
  it("retains receipt-only greetings and refuses replay after scope removal", async () => {
    const f = await fixture();
    f.input.text = "hello";
    const sent = await sendDeviceRoom(f.deps, f.grant, f.input);
    expect(sent).toMatchObject({ kind: "receipt-only", receipt: { key: "greeting" } });
    expect(await sendDeviceRoom(f.deps, f.grant, f.input)).toEqual(sent);
    expect(await db.prisma.run.count({ where: { threadId: f.group.thread!.id } })).toBe(0);
    await db.prisma.deviceGrant.update({ where: { id: f.grant.id }, data: { scopes: ["read"] } });
    await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
  });
  it("refuses duplicate room names and foreign rooms or thread substitutions before writes", async () => {
    const f = await fixture();
    await db.prisma.chatGroup.create({
      data: {
        ...f.scope,
        name: "Fixture room",
        members: { create: [f.chief, ...f.bots].map((bot) => ({ botId: bot.id })) },
        thread: { create: f.scope },
      },
    });
    await expect(
      sendDeviceRoom(f.deps, f.grant, {
        roomName: "fixture room",
        clientNonce: randomUUID(),
        text: "hello",
      }),
    ).rejects.toMatchObject({ status: 400 });
    const foreign = await fixture();
    await db.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: f.grant.userId },
    });
    await expect(
      sendDeviceRoom(f.deps, f.grant, { ...f.input, groupId: foreign.group.id }),
    ).rejects.toThrow();
    await expect(
      sendDeviceRoom(f.deps, f.grant, { ...f.input, threadId: foreign.group.thread!.id }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await db.prisma.message.count({ where: { threadId: f.group.thread!.id } })).toBe(0);
  });
  it("requires steer and retains the authority ceiling when continuing existing room runs", async () => {
    const f = await fixture();
    const first = await sendDeviceRoom(f.deps, f.grant, f.input);
    if (first.kind === "receipt-only") throw new Error("Expected room work");
    const secondGrant = await db.prisma.deviceGrant.create({
      data: {
        ...f.scope,
        instanceId: f.grant.instanceId,
        deviceName: "Second fixture device",
        devicePublicKey: "fixture-key-2",
        presencePublicKey: "fixture-presence-2",
        scopes: ["dispatch", "ordinary"],
      },
    });
    const next = { ...f.input, clientNonce: randomUUID() };
    await expect(sendDeviceRoom(f.deps, secondGrant, next)).rejects.toMatchObject({ status: 403 });
    expect(
      await db.prisma.message.count({ where: { threadId: f.group.thread!.id, role: "user" } }),
    ).toBe(1);
    await db.prisma.deviceGrant.update({
      where: { id: secondGrant.id },
      data: { scopes: ["dispatch", "ordinary", "steer"] },
    });
    const steered = await sendDeviceRoom(f.deps, secondGrant, next);
    expect(steered).toMatchObject({ runIds: first.runIds });
    const runs = await db.prisma.run.findMany({ where: { id: { in: first.runIds } } });
    for (const run of runs) expect(run.remoteDeviceGrantIds).toEqual([f.grant.id, secondGrant.id]);
    for (const run of runs) {
      const message = await db.prisma.$transaction(async (tx) => {
        const thread = await tx.thread.update({
          where: { id: run.threadId },
          data: { nextMessageSeq: { increment: 1 } },
          select: { nextMessageSeq: true },
        });
        return tx.message.create({
          data: {
            threadId: run.threadId,
            seq: thread.nextMessageSeq,
            role: "bot",
            botId: run.botId,
            runId: run.id,
            blocks: [{ kind: "text", text: "Fixture final answer." }],
          },
        });
      });
      await db.prisma.run.update({ where: { id: run.id }, data: { status: "completed" } });
      await db.prisma.$transaction((tx) => persistDispatchSummary(tx, run, "done", message.id));
      expect(await getDeviceRun(db.prisma, secondGrant, { runId: run.id })).toMatchObject({
        messageId: message.id,
        failure: null,
      });
    }
  });
  it("refuses a response after revocation during publication and denies every admitted run's tools", async () => {
    const f = await fixture();
    vi.mocked(f.deps.events.notify).mockImplementation(async () => {
      await db.prisma.deviceGrant.update({
        where: { id: f.grant.id },
        data: { revokedAt: new Date() },
      });
    });
    await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
    const runs = await db.prisma.run.findMany({ where: { originDeviceGrantId: f.grant.id } });
    expect(runs).toHaveLength(2);
    for (const run of runs)
      await expect(currentRemoteDecision(db.prisma, run.id, "file_read")).resolves.toMatchObject({
        allowed: false,
        kind: "authority",
      });
    await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
  });
  it("rolls back new room work at the existing active device-run limit", async () => {
    const f = await fixture();
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const task = await db.prisma.task.create({
          data: {
            ...f.scope,
            botId: f.bots[0]!.id,
            threadId: f.group.thread!.id,
            prompt: "Fixture task",
            status: "queued",
          },
        });
        await db.prisma.run.create({
          data: {
            ...f.scope,
            botId: f.bots[0]!.id,
            threadId: f.group.thread!.id,
            taskId: task.id,
            status: "queued",
            trigger: "user",
            originDeviceGrantId: f.grant.id,
            remoteDeviceGrantIds: [f.grant.id],
            remoteRootTaskId: task.id,
          },
        });
      }),
    );
    await expect(
      sendDeviceRoom(f.deps, f.grant, { ...f.input, text: "@Gamma do this task" }),
    ).rejects.toMatchObject({ status: 429 });
    expect(await db.prisma.message.count({ where: { threadId: f.group.thread!.id } })).toBe(0);
    expect(await db.prisma.run.count({ where: { threadId: f.group.thread!.id } })).toBe(20);
    expect(await db.prisma.task.count({ where: { threadId: f.group.thread!.id } })).toBe(20);
    expect(await db.prisma.dispatchReceipt.count({ where: { deviceGrantId: f.grant.id } })).toBe(0);
  });
  it("refuses an owner change between authenticated request and admission", async () => {
    const f = await fixture();
    await db.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: null },
    });
    await expect(sendDeviceRoom(f.deps, f.grant, f.input)).rejects.toMatchObject({ status: 403 });
    expect(await db.prisma.run.count({ where: { threadId: f.group.thread!.id } })).toBe(0);
  });
});
