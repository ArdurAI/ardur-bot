import type { JobPublisher } from "@ardurbot/adapter-kit";
import { runContinueJob } from "@ardurbot/adapter-kit";
import { validateDeviceApproval } from "@ardurbot/adapters";
import type { Actor, DeviceScope, PairingPayload } from "@ardurbot/contracts";
import {
  canonicalDispatchJson,
  DeviceProofSchema,
  DeviceScopeSchema,
  DispatchInputSchema,
  PairingPayloadSchema,
  pairingSignedText,
} from "@ardurbot/contracts";
import { effectiveRemoteAuthority } from "@ardurbot/core";
import type { DeviceGrant, PrismaClient, ThreadEvents } from "@ardurbot/db";
import {
  admitDispatch,
  auditDevice,
  authenticateDevice,
  completeDevicePairing,
  confirmShortCodePairing,
  DeviceRequestError,
  deviceDigest,
  dispatchState,
  issueDeviceNonce,
  loadRemoteAuthority,
  requestCancel,
  requestDispatchStop,
  requestShortCodePairing,
  requireDispatchEnabled,
  startDevicePairing,
  verifyDeviceSignature,
} from "@ardurbot/db";
import { Hono } from "hono";
import * as z from "zod";
import { requestBodyLimit } from "./request-body-limit.js";
import { acceptTeamTask } from "./team.js";

export interface RemoteDevicesDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
  publicUrl?: string;
  homeProof?: (challenge: string) => { certificate: string; signature: string };
}
function owner(actor: Actor) {
  if (!actor.isDeploymentOwner)
    throw new DeviceRequestError("Pair and manage devices from the home owner account.");
}
export function createRemoteDevices(deps: RemoteDevicesDeps) {
  const { prisma } = deps;
  const identity = () => prisma.instanceIdentity.findUniqueOrThrow({ where: { id: "home" } });
  return {
    async list(actor: Actor) {
      owner(actor);
      const home = await identity();
      const devices = await prisma.deviceGrant.findMany({
        where: { userId: actor.userId, spaceId: actor.spaceId, instanceId: home.instanceId },
        orderBy: { createdAt: "desc" },
      });
      const pending = await prisma.pendingDevicePairing.findMany({
        where: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          instanceId: home.instanceId,
          grantId: null,
          deniedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      return {
        instanceId: home.instanceId,
        homeName: home.homeName,
        fingerprint: home.fingerprint,
        devices: devices.map((device) => ({
          id: device.id,
          deviceName: device.deviceName,
          scopes: DeviceScopeSchema.array().parse(device.scopes),
          createdAt: device.createdAt.toISOString(),
          lastUsedAt: device.lastUsedAt?.toISOString() ?? null,
          lastPresenceAt: device.lastPresenceAt?.toISOString() ?? null,
          revokedAt: device.revokedAt?.toISOString() ?? null,
          defaultBotId: device.defaultBotId,
          kind: device.kind === "channel" ? ("channel" as const) : ("device" as const),
        })),
        pending: pending.map((request) => ({
          id: request.id,
          deviceName: request.deviceName,
          publicKeyFingerprint: deviceDigest(request.devicePublicKey),
        })),
      };
    },
    async start(actor: Actor, input: { scopes: DeviceScope[]; hints: string[] }) {
      owner(actor);
      const home = await identity();
      if (input.scopes.some((scope) => !home.scopes.includes(scope)))
        throw new DeviceRequestError("These permissions are unavailable at home.");
      const issued = await startDevicePairing(prisma, {
        userId: actor.userId,
        spaceId: actor.spaceId,
        instanceId: home.instanceId,
        scopes: input.scopes,
      });
      const hints = [
        ...new Set([
          ...input.hints,
          ...(deps.publicUrl?.startsWith("https:") ? [new URL(deps.publicUrl).origin] : []),
        ]),
      ].slice(0, 8);
      const payload: PairingPayload = PairingPayloadSchema.parse({
        version: 1,
        challenge: issued.challenge,
        instanceId: home.instanceId,
        homeName: home.homeName,
        fingerprint: home.fingerprint,
        certificateFingerprint: home.certificateFingerprint,
        hints,
      });
      return { payload, shortCode: issued.shortCode, expiresAt: issued.expiresAt.toISOString() };
    },
    async rename(actor: Actor, input: { id: string; deviceName: string }) {
      owner(actor);
      const changed = await prisma.deviceGrant.updateMany({
        where: { id: input.id, userId: actor.userId, spaceId: actor.spaceId, revokedAt: null },
        data: { deviceName: input.deviceName },
      });
      if (!changed.count) throw new DeviceRequestError("This device is no longer available.");
      return { ok: true as const };
    },
    async revoke(actor: Actor, input: { id: string }) {
      owner(actor);
      const home = await identity();
      await prisma.$transaction(async (tx) => {
        const grant = await tx.deviceGrant.findFirst({
          where: { id: input.id, userId: actor.userId, spaceId: actor.spaceId },
        });
        const changed = await tx.deviceGrant.updateMany({
          where: { id: input.id, userId: actor.userId, spaceId: actor.spaceId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (changed.count)
          await auditDevice(tx, grant?.kind === "channel" ? "channel.revoked" : "device.revoked", {
            instanceId: home.instanceId,
            userId: actor.userId,
            spaceId: actor.spaceId,
            grantId: input.id,
          });
      });
      return { ok: true as const };
    },
    async confirm(actor: Actor, input: { id: string; allow: boolean }) {
      owner(actor);
      await confirmShortCodePairing(
        prisma,
        { userId: actor.userId, spaceId: actor.spaceId },
        input.id,
        input.allow,
      );
      return { ok: true as const };
    },
  };
}
const pairInput = z.strictObject({
  platform: z.enum(["ios", "android", "darwin", "linux", "win32", "web"]).optional(),
  challenge: z.string().min(8).max(128),
  instanceId: z.string().max(128),
  deviceName: z.string().trim().min(1).max(80),
  devicePublicKey: z.string().min(1).max(256),
  presencePublicKey: z.string().min(1).max(256),
  signature: z.string().min(1).max(256),
});
export const DEVICE_READ_PROCEDURES = new Set([
  "account/get",
  "account/localDevices",
  "me",
  "bootstrap",
  "spaces/list",
  "bots/get",
  "bots/list",
  "groups/list",
  "agentSkills/list",
  "routines/list",
  "threads/head",
  "threads/get",
  "threads/messages",
  "threads/markRead",
  "botSections/list",
  "team/board",
  "comparisons/list",
  "comparisons/get",
]);
function publicGrant(grant: DeviceGrant) {
  return {
    grantId: grant.id,
    instanceId: grant.instanceId,
    spaceId: grant.spaceId,
    scopes: grant.scopes,
  };
}
export function mountRemoteDevices(
  app: Hono,
  deps: RemoteDevicesDeps & {
    read: (grant: DeviceGrant, procedure: string, input: unknown) => Promise<unknown>;
  },
) {
  const device = new Hono();
  device.onError((error, c) => {
    if (error instanceof DeviceRequestError)
      return c.json({ message: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ message: "This request is incomplete; try again." }, 400);
    return c.json({ message: "Home could not finish this request; try again." }, 500);
  });
  device.use("/device/*", requestBodyLimit(128 * 1024));
  // Per-process admission is an abuse bound; nonce use, lockout and authorization are durable.
  let windowStart = 0;
  let requests = 0;
  device.use("/device/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 600) return c.json({ message: "Wait a moment before trying again." }, 429);
    if (c.req.method !== "POST")
      return c.json({ message: "This action is unavailable from a device." }, 403);
    await next();
  });
  const identity = () => deps.prisma.instanceIdentity.findUniqueOrThrow({ where: { id: "home" } });
  device.post("/device/pair", async (c) => {
    const home = await identity();
    return c.json(
      publicGrant(
        await completeDevicePairing(
          deps.prisma,
          home.instanceId,
          pairInput.parse(await c.req.json()),
        ),
      ),
    );
  });
  device.post("/device/code", async (c) => {
    const home = await identity();
    return c.json(
      await requestShortCodePairing(
        deps.prisma,
        home.instanceId,
        pairInput.parse(await c.req.json()),
      ),
    );
  });
  device.post("/device/claim", async (c) => {
    const input = z
      .strictObject({ pendingId: z.string().max(128), signature: z.string().max(256) })
      .parse(await c.req.json());
    const pending = await deps.prisma.pendingDevicePairing.findUnique({
      where: { id: input.pendingId },
    });
    if (
      !pending ||
      pending.deniedAt ||
      pending.expiresAt <= new Date() ||
      !verifyDeviceSignature(
        pending.devicePublicKey,
        pairingSignedText(
          pending.id,
          pending.instanceId,
          pending.devicePublicKey,
          pending.presencePublicKey,
        ),
        input.signature,
      )
    )
      throw new DeviceRequestError("This pairing request is unavailable; start again at home.");
    const grant = pending.grantId
      ? await deps.prisma.deviceGrant.findFirst({ where: { id: pending.grantId, revokedAt: null } })
      : null;
    return c.json(grant ? publicGrant(grant) : { waiting: true });
  });
  device.post("/device/nonce", async (c) => {
    const home = await identity();
    const input = z
      .strictObject({
        grantId: z.string().min(1).max(128).optional(),
        purpose: z.enum(["request", "presence"]).default("request"),
        clientChallenge: z.string().min(16).max(128),
      })
      .parse(await c.req.json());
    return c.json({
      instanceId: home.instanceId,
      homeName: home.homeName,
      fingerprint: home.fingerprint,
      certificateFingerprint: home.certificateFingerprint,
      ...deps.homeProof?.(input.clientChallenge),
      ...(input.grantId
        ? await issueDeviceNonce(deps.prisma, home.instanceId, input.grantId, input.purpose)
        : {}),
    });
  });
  device.post("/device/request", async (c) => {
    const input = z
      .strictObject({ proof: DeviceProofSchema, operation: z.string().max(64), body: z.unknown() })
      .parse(await c.req.json());
    const home = await identity();
    const grant = await authenticateDevice(
      deps.prisma,
      home.instanceId,
      input.proof,
      input.operation,
      input.body,
    );
    const requireScope = (scope: string) => {
      if (!grant.scopes.includes(scope))
        throw new DeviceRequestError("This action is unavailable from this device.");
    };
    if (["dispatch", "answer", "team-accept", "default"].includes(input.operation))
      await requireDispatchEnabled(deps.prisma, grant.spaceId);
    switch (input.operation) {
      case "presence":
        return c.json({ ok: true });
      case "rpc": {
        requireScope("read");
        const read = z.object({ procedure: z.string(), input: z.unknown() }).parse(input.body);
        if (!DEVICE_READ_PROCEDURES.has(read.procedure))
          throw new DeviceRequestError("Change permissions or connections at home.");
        return c.json(await deps.read(grant, read.procedure, read.input));
      }
      case "team-stop": {
        requireScope("stop");
        const body = z.object({ rootTaskId: z.string() }).parse(input.body);
        return c.json(await requestCancel(deps.prisma, grant, body.rootTaskId));
      }
      case "team-accept": {
        requireScope("consequential");
        const body = z.object({ id: z.string() }).parse(input.body);
        return c.json(
          await acceptTeamTask(
            deps.prisma,
            { userId: grant.userId, spaceId: grant.spaceId, email: "", isDeploymentOwner: false },
            body.id,
          ),
        );
      }
      case "dispatch": {
        const receipt = await admitDispatch(
          deps.prisma,
          grant,
          DispatchInputSchema.parse(input.body),
        );
        // Admission is durable even when notification or enqueue fails; the existing reconciler recovers queued runs.
        await deps.jobs.enqueue(runContinueJob(receipt.runId)).catch(() => undefined);
        return c.json(receipt);
      }
      case "stop": {
        requireScope("stop");
        const body = z.object({ taskId: z.string() }).parse(input.body);
        const result = await requestDispatchStop(deps.prisma, grant, body.taskId);
        const runs = await deps.prisma.run.findMany({
          where: { taskId: body.taskId, cancelRequestedAt: { not: null }, cancelConfirmedAt: null },
        });
        for (const run of runs)
          await deps.jobs.enqueue(runContinueJob(run.id)).catch(() => undefined);
        return c.json(result);
      }
      case "tasks": {
        requireScope("read");
        const receipts = await deps.prisma.dispatchReceipt.findMany({
          where: { instanceId: home.instanceId, spaceId: grant.spaceId, deviceGrantId: grant.id },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        const runs = await deps.prisma.run.findMany({
          where: {
            id: { in: receipts.map((r) => r.runId) },
            spaceId: grant.spaceId,
            userId: grant.userId,
          },
        });
        return c.json(
          receipts.flatMap((r) => {
            const run = runs.find((v) => v.id === r.runId);
            return run
              ? [
                  {
                    taskId: r.taskId,
                    runId: r.runId,
                    botId: r.botId,
                    threadId: r.threadId,
                    state: dispatchState(run),
                    cancelRequested: Boolean(run.cancelRequestedAt),
                  },
                ]
              : [];
          }),
        );
      }
      case "default": {
        requireScope("dispatch");
        const body = z.object({ botId: z.string() }).parse(input.body);
        if (
          !effectiveRemoteAuthority(
            await loadRemoteAuthority(deps.prisma, grant, body.botId),
          ).includes("dispatch")
        )
          throw new DeviceRequestError("This bot is unavailable on this device.");
        await deps.prisma.deviceGrant.updateMany({
          where: { id: grant.id, revokedAt: null },
          data: { defaultBotId: body.botId },
        });
        return c.json({ ok: true });
      }
      case "approvals": {
        requireScope("approve");
        const body = z.object({ runId: z.string() }).parse(input.body);
        const bindings = await deps.prisma.deviceApprovalBinding.findMany({
          where: {
            instanceId: home.instanceId,
            userId: grant.userId,
            spaceId: grant.spaceId,
            runId: body.runId,
            answeredAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        return c.json(
          bindings.map(({ effectId, nonce, requestFingerprint, expiresAt }) => ({
            effectId,
            nonce,
            requestFingerprint,
            expiresAt,
          })),
        );
      }
      case "answer": {
        requireScope("approve");
        const body = z
          .strictObject({
            runId: z.string(),
            messageId: z.string(),
            answer: z.enum(["allow", "deny", "remote-retry"]),
            effectId: z.string().optional(),
            nonce: z.string().optional(),
            requestFingerprint: z.string().optional(),
          })
          .parse(input.body);
        const run = await deps.prisma.run.findFirst({
          where: {
            id: body.runId,
            spaceId: grant.spaceId,
            userId: grant.userId,
            status: "waiting_input",
          },
        });
        if (!run)
          throw new DeviceRequestError("This task is no longer waiting for an answer.", 409);
        if (body.answer === "remote-retry") {
          if (!grant.lastPresenceAt || Date.now() - grant.lastPresenceAt.getTime() >= 10 * 60_000)
            throw new DeviceRequestError("Confirm your presence before this action runs.");
          const message = await deps.prisma.message.findFirst({
            where: { id: body.messageId, runId: run.id, threadId: run.threadId },
          });
          if (!canonicalDispatchJson(message?.blocks).includes('"remote-retry"'))
            throw new DeviceRequestError("Answer this request at home.");
        } else if (!body.effectId || !body.nonce || !body.requestFingerprint)
          throw new DeviceRequestError("This older approval must be answered at home.");
        const answered = await deps.events.answerRunInput({
          spaceId: run.spaceId,
          threadId: run.threadId,
          runId: run.id,
          messageId: body.messageId,
          answeredByUserId: grant.userId,
          answer: body.answer,
          ...(body.answer === "remote-retry"
            ? {}
            : {
                deviceApprovalValidator: (tx, effect) =>
                  validateDeviceApproval(tx, effect, {
                    effectId: body.effectId!,
                    nonce: body.nonce!,
                    requestFingerprint: body.requestFingerprint!,
                    grantId: grant.id,
                    instanceId: home.instanceId,
                    decision: body.answer as "allow" | "deny",
                  }),
              }),
        });
        if (!answered) throw new DeviceRequestError("This approval changed; review it again.", 409);
        await deps.jobs.enqueue(runContinueJob(run.id)).catch(() => undefined);
        return c.json({ ok: true });
      }
      case "summaries": {
        requireScope("read");
        const summaries = await deps.prisma.dispatchSummary.findMany({
          where: { deviceGrantId: grant.id, acknowledgedAt: null },
          orderBy: { createdAt: "asc" },
          take: 100,
        });
        return c.json(summaries);
      }
      case "acknowledge": {
        const body = z.object({ taskId: z.string() }).parse(input.body);
        await deps.prisma.dispatchSummary.updateMany({
          where: { taskId: body.taskId, deviceGrantId: grant.id, acknowledgedAt: null },
          data: { acknowledgedAt: new Date() },
        });
        return c.json({ ok: true });
      }
      default:
        throw new DeviceRequestError("Change permissions or connections at home.");
    }
  });
  app.route("/", device);
}
