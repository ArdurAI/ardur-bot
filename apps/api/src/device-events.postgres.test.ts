import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type { DeviceEventsInput } from "@ardurbot/contracts";
import { ALL_DEVICE_SCOPES, deviceSignedText } from "@ardurbot/contracts";
import {
  createDb,
  createThreadEvents,
  deviceDigest,
  provisionMessagingIdentity,
} from "@ardurbot/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountRemoteDevices } from "./remote-devices.js";

const enabled =
  process.env.CI === "1" &&
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL);
// Only the integration harness supplies this suite's disposable database; no worker runs.
describe.skipIf(!enabled).sequential("signed Stage 5 run event windows", () => {
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
    await db.prisma.instanceIdentity.upsert({
      where: { id: "home" },
      update: {},
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
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const grant = await db.prisma.deviceGrant.create({
      data: {
        ...scope,
        instanceId: "fixture-home",
        deviceName: "Fixture device",
        devicePublicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
        presencePublicKey: "fixture-presence",
        scopes: ["read"],
      },
    });
    const bot = await db.prisma.bot.create({
      data: { ...scope, name: "Fixture bot", color: "ink" },
    });
    const thread = await db.prisma.thread.create({ data: { ...scope, botId: bot.id } });
    const shared = { ...scope, botId: bot.id, threadId: thread.id };
    const task = await db.prisma.task.create({
      data: { ...shared, prompt: "Fixture task", status: "running" },
    });
    const run = await db.prisma.run.create({
      data: {
        ...shared,
        taskId: task.id,
        trigger: "user",
        status: "running",
        originDeviceGrantId: grant.id,
      },
    });
    const receipt = await db.prisma.dispatchReceipt.create({
      data: {
        instanceId: grant.instanceId,
        spaceId: grant.spaceId,
        deviceGrantId: grant.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        runId: run.id,
        clientNonce: randomUUID(),
        payloadFingerprint: "fixture",
      },
    });
    const events = createThreadEvents(db.prisma, undefined, { catchUpMs: 10 });
    const shutdown = new AbortController();
    const app = new Hono();
    mountRemoteDevices(app, {
      prisma: db.prisma,
      events,
      shutdown: shutdown.signal,
      jobs: {} as never,
      read: async () => {
        throw new Error("Unexpected RPC");
      },
    });
    const input: DeviceEventsInput = {
      runId: run.id,
      threadId: thread.id,
      botId: bot.id,
      cursor: -1,
    };
    const request = async (body = input, device = grant) => {
      const nonce = randomBytes(32).toString("base64url");
      await db.prisma.deviceNonce.create({
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
        Buffer.from(deviceSignedText(device.instanceId, proof, "events", body)),
        keys.privateKey,
      ).toString("base64");
      return app.request("/device/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "events", body, proof }),
      });
    };
    const append = (text = "fixture event", runId = run.id) =>
      events.append({
        spaceId: scope.spaceId,
        botId: bot.id,
        threadId: thread.id,
        runId,
        type: "thread.progress",
        payload: { text },
      });
    return { scope, bot, thread, run, grant, receipt, input, request, append, shutdown, events };
  }
  const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);
  async function rest(reader: ReadableStreamDefaultReader<Uint8Array>) {
    let text = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      text += decode(part.value);
    }
    reader.releaseLock();
    return text;
  }
  it("disconnects and resumes with fresh nonces across other-run sequence gaps", async () => {
    const f = await fixture();
    try {
      const first = await f.append("first");
      const other = await db.prisma.run.create({
        data: {
          ...f.scope,
          botId: f.bot.id,
          threadId: f.thread.id,
          taskId: f.run.taskId,
          trigger: "user",
          status: "running",
        },
      });
      await f.append("other run", other.id);
      const last = await f.append("last");
      const initial = await f.request();
      expect(initial.status).toBe(200);
      const reader = initial.body!.getReader();
      expect(decode((await reader.read()).value)).toContain(`id: ${first.seq}\n`);
      await reader.cancel();
      const resumed = await f.request({ ...f.input, cursor: first.seq });
      const next = resumed.body!.getReader();
      const text = decode((await next.read()).value);
      expect(text).toContain(`id: ${last.seq}\n`);
      expect(text).not.toContain("other run");
      f.shutdown.abort();
      expect(await rest(next)).toContain(`"nextCursor":${last.seq}`);
    } finally {
      f.shutdown.abort();
    }
  });
  it.each(["grant", "membership", "receipt", "scope", "bot-owner"] as const)(
    "stops an open window after losing %s and refuses the next window",
    async (kind) => {
      const f = await fixture();
      try {
        await f.append("before");
        const response = await f.request();
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        expect(decode((await reader.read()).value)).toContain("before");
        if (kind === "grant")
          await db.prisma.deviceGrant.update({
            where: { id: f.grant.id },
            data: { revokedAt: new Date() },
          });
        if (kind === "membership")
          await db.prisma.spaceMember.delete({ where: { spaceId_userId: f.scope } });
        if (kind === "receipt")
          await db.prisma.dispatchReceipt.delete({ where: { id: f.receipt.id } });
        if (kind === "scope")
          await db.prisma.deviceGrant.update({ where: { id: f.grant.id }, data: { scopes: [] } });
        if (kind === "bot-owner") {
          const other = await provisionMessagingIdentity(
            db.prisma,
            { provider: "sendblue", address: `fixture-${randomUUID()}` },
            { signupsEnabled: undefined, signupAllowlist: undefined },
          );
          await db.prisma.bot.update({ where: { id: f.bot.id }, data: { userId: other.userId } });
        }
        await f.append("after access lost");
        const text = await rest(reader);
        expect(text).not.toContain("after access lost");
        expect(text).toContain('"reason":"access_lost"');
        expect((await f.request()).status).toBeGreaterThanOrEqual(400);
      } finally {
        f.shutdown.abort();
      }
    },
  );
  it("checks room member removal on an open window", async () => {
    const f = await fixture();
    try {
      const remaining = await Promise.all(
        ["Fixture peer one", "Fixture peer two"].map((name) =>
          db.prisma.bot.create({ data: { ...f.scope, name, color: "ink" } }),
        ),
      );
      const group = await db.prisma.chatGroup.create({
        data: {
          ...f.scope,
          name: "Fixture room",
          members: { create: [f.bot, ...remaining].map((bot) => ({ botId: bot.id })) },
          thread: { create: f.scope },
        },
        include: { thread: true },
      });
      const threadId = group.thread!.id;
      await db.prisma.task.update({ where: { id: f.run.taskId }, data: { threadId } });
      await db.prisma.run.update({ where: { id: f.run.id }, data: { threadId } });
      await db.prisma.dispatchReceipt.update({ where: { id: f.receipt.id }, data: { threadId } });
      const response = await f.request({
        runId: f.run.id,
        groupId: group.id,
        threadId,
        cursor: -1,
      });
      expect(response.status).toBe(200);
      await db.prisma.chatGroupMember.deleteMany({ where: { groupId: group.id, botId: f.bot.id } });
      expect(await response.text()).toContain('"reason":"access_lost"');
    } finally {
      f.shutdown.abort();
    }
  });
  it("refuses wrong run, thread, target, ahead cursor and a second device without a receipt", async () => {
    const f = await fixture();
    try {
      const second = await db.prisma.deviceGrant.create({
        data: {
          ...f.scope,
          instanceId: f.grant.instanceId,
          deviceName: "Other fixture device",
          devicePublicKey: f.grant.devicePublicKey,
          presencePublicKey: "fixture-presence",
          scopes: ["read"],
        },
      });
      for (const body of [
        { ...f.input, runId: "missing-run" },
        { ...f.input, threadId: "missing-thread" },
        { ...f.input, botId: "missing-bot" },
        { ...f.input, cursor: 100 },
      ])
        expect((await f.request(body)).status).toBe(403);
      expect((await f.request(f.input, second)).status).toBe(403);
    } finally {
      f.shutdown.abort();
    }
  });
  it.each(["user", "space"] as const)("refuses a forged receipt for another %s", async (kind) => {
    const f = await fixture();
    try {
      const other = await provisionMessagingIdentity(
        db.prisma,
        { provider: "sendblue", address: `fixture-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      );
      await db.prisma.run.update({
        where: { id: f.run.id },
        data: kind === "user" ? { userId: other.userId } : { spaceId: other.spaceId },
      });
      expect((await f.request()).status).toBe(403);
    } finally {
      f.shutdown.abort();
    }
  });
  it("releases a durable follower on shutdown with the last event cursor", async () => {
    const f = await fixture();
    try {
      const event = await f.append();
      const response = await f.request();
      const reader = response.body!.getReader();
      expect(decode((await reader.read()).value)).toContain(`id: ${event.seq}\n`);
      f.shutdown.abort();
      expect(await rest(reader)).toContain(`{"nextCursor":${event.seq},"reason":"shutdown"}`);
    } finally {
      f.shutdown.abort();
    }
  });
});
