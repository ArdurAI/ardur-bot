import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import { deviceThreadProjection } from "@ardurbot/adapters";
import { ALL_DEVICE_SCOPES, deviceSignedText } from "@ardurbot/contracts";
import type { DeviceGrant, PrismaClient, ThreadEvents } from "@ardurbot/db";
import { createDb, deviceDigest } from "@ardurbot/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mountRemoteDevices } from "./remote-devices.js";
import { loadMessagePage } from "./thread-message-pages.js";

const postgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
postgres("signed Stage 3 device operations (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let app: Hono;
  let grant: DeviceGrant;
  let otherDevice: DeviceGrant;
  let unadmittedDevice: DeviceGrant;
  let otherUser: DeviceGrant;
  let otherSpace: DeviceGrant;
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const presence = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
  const jobs = { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher;
  let botId: string;
  let threadId: string;
  const spaceId = "device-stage3-space";
  const userId = "device-stage3-user";
  const oldRun = "overflow-run-000";
  const oldTask = "overflow-task-000";
  async function request(operation: string, body: unknown, device = grant) {
    const nonce = randomBytes(32).toString("base64url");
    await prisma.deviceNonce.create({
      data: {
        hash: deviceDigest(nonce),
        grantId: device.id,
        purpose: "request",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const proof = { grantId: device.id, nonce, timestamp: Date.now(), signature: "" };
    proof.signature = sign(
      "sha256",
      Buffer.from(deviceSignedText("fixture-home", proof, operation, body)),
      keys.privateKey,
    ).toString("base64");
    return app.request("/device/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, body, proof }),
    });
  }
  beforeAll(async () => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: "device-stage3-org",
        name: "Device fixture",
        slug: "device-stage3-org",
        createdAt: new Date(),
        spaces: {
          create: [
            { id: spaceId, name: "Fixture" },
            { id: "device-stage3-other-space", name: "Other fixture" },
          ],
        },
      },
    });
    for (const id of [userId, "device-stage3-other-user"]) {
      await prisma.user.create({ data: { id, name: "Fixture", email: `${id}@example.test` } });
      await prisma.member.create({
        data: {
          id: `${id}-organization-membership`,
          organizationId: "device-stage3-org",
          userId: id,
          role: "member",
          createdAt: new Date(),
        },
      });
      for (const space of [spaceId, "device-stage3-other-space"]) {
        await prisma.spaceMember.create({
          data: {
            id: `${id}-${space}-membership`,
            organizationId: "device-stage3-org",
            spaceId: space,
            userId: id,
            role: "member",
            createdAt: new Date(),
          },
        });
      }
    }
    await prisma.instanceIdentity.create({
      data: {
        id: "home",
        instanceId: "fixture-home",
        homeName: "Fixture",
        publicKey,
        fingerprint: "a".repeat(64),
        certificate: "fixture-certificate",
        certificateFingerprint: "b".repeat(64),
        privateKeyCiphertext: "fixture-ciphertext",
        scopes: [...ALL_DEVICE_SCOPES],
      },
    });
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Fixture", color: "ink" },
    });
    botId = bot.id;
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId } });
    threadId = thread.id;
    const createGrant = (id: string, user = userId, space = spaceId) =>
      prisma.deviceGrant.create({
        data: {
          id,
          userId: user,
          spaceId: space,
          instanceId: "fixture-home",
          deviceName: "Fixture",
          devicePublicKey: publicKey,
          presencePublicKey: presence,
          defaultBotId: botId,
          scopes: [...ALL_DEVICE_SCOPES],
        },
      });
    grant = await createGrant("device-stage3-primary");
    otherDevice = await createGrant("device-stage3-secondary");
    unadmittedDevice = await createGrant("device-stage3-unadmitted");
    otherUser = await createGrant("device-stage3-foreign-user", "device-stage3-other-user");
    otherSpace = await createGrant(
      "device-stage3-foreign-space",
      userId,
      "device-stage3-other-space",
    );
    const shared = { spaceId, userId, botId, threadId };
    await prisma.task.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({
        ...shared,
        id: `overflow-task-${String(i).padStart(3, "0")}`,
        prompt: "Fixture",
        status: "queued",
      })),
    });
    await prisma.run.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({
        ...shared,
        id: `overflow-run-${String(i).padStart(3, "0")}`,
        taskId: `overflow-task-${String(i).padStart(3, "0")}`,
        status: "queued",
        trigger: "user",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })),
    });
    await prisma.dispatchReceipt.createMany({
      data: Array.from({ length: 105 }, (_, i) => ({
        instanceId: grant.instanceId,
        spaceId,
        deviceGrantId: grant.id,
        botId,
        threadId,
        clientNonce: `overflow-request-${String(i).padStart(3, "0")}`,
        payloadFingerprint: "fixture",
        taskId: `overflow-task-${String(i).padStart(3, "0")}`,
        runId: `overflow-run-${String(i).padStart(3, "0")}`,
        createdAt: new Date(i * 1000),
      })),
    });
    app = new Hono();
    mountRemoteDevices(app, {
      prisma,
      jobs,
      events: {} as ThreadEvents,
      read: async (_device, procedure, input) => {
        expect(procedure).toBe("threads/messages");
        const body = input as { threadId: string; before?: number; around?: { messageId: string } };
        return deviceThreadProjection(
          await loadMessagePage(prisma, body.threadId, body.before, 100, body.around),
          spaceId,
        );
      },
    });
  }, 30_000);
  afterAll(async () => {
    await close?.();
  });

  it("recovers lost admission with fresh proof, refuses changed body and isolates request ids", async () => {
    const body = { clientNonce: "stage3-lost-response-001", botId, text: "One fixture turn" };
    const lost = await request("dispatch", body);
    expect(lost.status).toBe(200);
    const admission = await lost.json();
    const recovered = await request("dispatch", { ...body });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(admission);
    expect(
      await prisma.dispatchReceipt.count({
        where: { deviceGrantId: grant.id, clientNonce: body.clientNonce },
      }),
    ).toBe(1);
    const changed = await request("dispatch", { ...body, text: "Different turn" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({
      message: "This request changed; send it as a new task.",
    });
    const separate = await request("dispatch", body, otherDevice);
    expect(separate.status).toBe(200);
    const separateAdmission = (await separate.json()) as { taskId: string; runId: string };
    expect(separateAdmission.taskId).not.toBe((admission as { taskId: string }).taskId);
    expect(separateAdmission.runId).not.toBe((admission as { runId: string }).runId);
  });

  it("finds exact old records outside 100 and paginates tied timestamps without duplicates", async () => {
    const tasks = await request("tasks", {});
    const listed = (await tasks.json()) as Array<{ taskId: string }>;
    expect(listed).toHaveLength(100);
    expect(listed.some((row) => row.taskId === oldTask)).toBe(false);
    for (const [operation, body, field] of [
      ["tasks/get", { taskId: oldTask }, "task"],
      ["runs/get", { runId: oldRun }, "run"],
    ] as const) {
      const response = await request(operation, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        [field]: { taskId: oldTask, runId: oldRun, status: "queued", state: "accepted" },
      });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await request("runs/list", { limit: 17, ...(cursor ? { cursor } : {}) });
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        runs: Array<{ runId: string }>;
        nextCursor: string | null;
      };
      expect(page.runs.length).toBeLessThanOrEqual(17);
      seen.push(...page.runs.map((row) => row.runId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(106);
    expect(seen.filter((id) => id.startsWith("overflow"))).toEqual(
      Array.from({ length: 105 }, (_, i) => `overflow-run-${String(104 - i).padStart(3, "0")}`),
    );
    expect((await request("runs/list", { limit: 101 })).status).toBe(400);
  });

  const reads = () =>
    [
      ["runs/get", { runId: oldRun }],
      ["tasks/get", { taskId: oldTask }],
      ["runs/list", { cursor: oldRun, limit: 2 }],
      ["messages/get", { botId, threadId }],
    ] as const;
  it("refuses cross-user, cross-space and unadmitted-device targets on every new read without revealing existence", async () => {
    for (const foreign of [otherUser, otherSpace])
      for (const [operation, body] of reads()) {
        const response = await request(operation, body, foreign);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          message: "This record is unavailable from this device.",
        });
      }
    for (const [operation, body] of reads()) {
      expect((await request(operation, body, unadmittedDevice)).status).toBe(403);
    }
    for (const foreign of [otherUser, otherSpace, otherDevice]) {
      const page = await request("runs/list", {}, foreign);
      const result = (await page.json()) as { runs: unknown[] };
      expect(page.status).toBe(200);
      expect(result.runs.length).toBe(foreign.id === otherDevice.id ? 1 : 0);
    }
    const absent = await request("runs/get", { runId: "missing-fixture" });
    expect(await absent.json()).toEqual({
      message: "This record is unavailable from this device.",
    });
  });
  it("refuses revoked grants and removed read scope on every new operation", async () => {
    await prisma.deviceGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    for (const [operation, body] of reads())
      expect((await request(operation, body)).status).toBe(401);
    await prisma.deviceGrant.update({
      where: { id: grant.id },
      data: { revokedAt: null, scopes: [] },
    });
    for (const [operation, body] of reads())
      expect((await request(operation, body)).status).toBe(403);
    await prisma.deviceGrant.update({
      where: { id: grant.id },
      data: { scopes: [...ALL_DEVICE_SCOPES] },
    });
  });
  it("preserves approval wait and cancellation request versus confirmation", async () => {
    await prisma.run.update({
      where: { id: oldRun },
      data: { status: "waiting_input", cancelRequestedAt: new Date() },
    });
    const waiting = await request("runs/get", { runId: oldRun });
    expect(await waiting.json()).toMatchObject({
      run: {
        status: "waiting_input",
        state: "running",
        cancelRequested: true,
        cancelConfirmed: false,
      },
    });
    await prisma.run.update({
      where: { id: oldRun },
      data: { status: "cancelled", cancelConfirmedAt: new Date() },
    });
    const stopped = await request("runs/get", { runId: oldRun });
    expect(await stopped.json()).toMatchObject({
      run: { status: "cancelled", state: "stopped", cancelRequested: true, cancelConfirmed: true },
    });
  });
  it("loads safe persisted provider and runtime categories without returning diagnostics", async () => {
    await prisma.run.update({
      where: { id: oldRun },
      data: { status: "failed", error: "Untrusted diagnostic" },
    });
    const pin = {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "fixture",
      effort: "high",
      credentialId: null,
      revision: 1,
    };
    for (const [index, payload, category] of [
      [1, { error: "Untrusted diagnostic", providerErrorKind: "auth" }, "signed-out"],
      [
        2,
        {
          error: "Untrusted diagnostic",
          runtimeProblem: {
            kind: "problem",
            code: "pin-credential-missing",
            pin,
            reason: "Untrusted diagnostic",
            reasonId: "connection-missing",
            actions: ["connect"],
          },
        },
        "connection-missing",
      ],
    ] as const) {
      await prisma.event.create({
        data: {
          spaceId,
          botId,
          threadId,
          runId: oldRun,
          seq: 1000 + index,
          type: "run.failed",
          payload,
        },
      });
      const response = await request("runs/get", { runId: oldRun });
      const text = await response.text();
      expect(text).not.toContain("Untrusted diagnostic");
      expect(JSON.parse(text).run.failure.category).toBe(category);
      expect(JSON.parse(text).run.failure.message).toEqual(expect.any(String));
    }
  });
  it("keeps a completed missing answer explicit and uses the existing bounded message projection", async () => {
    await prisma.run.update({ where: { id: oldRun }, data: { status: "completed" } });
    const completed = await request("runs/get", { runId: oldRun });
    expect(await completed.json()).toMatchObject({
      run: {
        status: "completed",
        messageId: null,
        failure: {
          category: "other",
          message: "The task finished, but its answer is unavailable. Open it at home.",
        },
      },
    });
    await prisma.message.createMany({
      data: Array.from({ length: 105 }, (_, seq) => ({
        id: `device-stage3-message-${seq}`,
        threadId,
        botId,
        runId: oldRun,
        seq: 2000 + seq,
        role: "bot",
        blocks: [{ kind: "text", text: "Fixture answer" }],
      })),
    });
    const response = await request("messages/get", { botId, threadId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      deviceThreadProjection(await loadMessagePage(prisma, threadId, undefined, 100), spaceId),
    );
    const page = await request("messages/get", { botId, threadId, before: 2005 });
    expect(await page.json()).toEqual(
      deviceThreadProjection(await loadMessagePage(prisma, threadId, 2005, 100), spaceId),
    );
  });
});
