import { randomUUID } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import { canonicalDispatchJson } from "@ardurbot/contracts";
import {
  classifyRemoteTool,
  effectiveRemoteAuthority,
  remotePermissionExpansion,
} from "@ardurbot/core";
import type {
  DeviceApprovalBinding,
  ExternalEffect,
  Prisma,
  PrismaClient,
  Run,
} from "@ardurbot/db";
import {
  auditDevice,
  DeviceRequestError,
  deviceDigest,
  evaluateRemoteExecution,
  loadRemoteAuthority,
} from "@ardurbot/db";
import type { BoundApprovalRoute } from "./approval-effect.js";
import { boundDirectApprovalDetails, catalogApprovalDetails } from "./approval-effect.js";
import { BACKGROUND_WORK_PROBE, cancelComputerRunWorkArgv } from "./computer-idle.js";
import { integrationApprovalDetailsForCall } from "./integration-access.js";

/** A cancelled model turn is not proof that its background shell or browser stopped. */
export async function stopRemoteComputerWork(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  computerId: string,
  runId: string,
  context: AdapterContext,
): Promise<boolean> {
  const cleanup = { ...context, cancelRunWork: true, signal: AbortSignal.timeout(30_000) };
  try {
    let cancelled = false;
    for await (const event of sandbox.execute(
      computer,
      { argv: cancelComputerRunWorkArgv(computerId, runId), timeoutMs: 15_000 },
      cleanup,
    )) {
      if (event.type === "exit") cancelled = event.code === 0;
    }
    if (!cancelled) return false;
    let idle = false;
    let output = "";
    for await (const event of sandbox.execute(
      computer,
      {
        argv: [
          "bash",
          "-c",
          BACKGROUND_WORK_PROBE,
          "ardurbot-background-probe",
          `${computerId}-${runId}`,
        ],
        timeoutMs: 10_000,
      },
      cleanup,
    )) {
      if (event.type === "exit") idle = event.code === 1;
      if (event.type === "stdout") output += event.data;
    }
    if (!idle || output.trim() !== "ardurbot-background-idle") return false;
    await sandbox.releaseScreen?.(computer, cleanup);
    return true;
  } catch {
    return false;
  }
}

export const REMOTE_APPROVAL_MARKER = "__ardurbotCatalogTool";
export class DispatchStopRequested extends Error {
  constructor() {
    super("Stopping this task; completed actions stay completed.");
  }
}
export async function currentRemoteDecision(prisma: PrismaClient, runId: string, tool: string) {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) throw new Error("This task is no longer available.");
  if (run.cancelRequestedAt) throw new DispatchStopRequested();
  // A later reply can narrow an already running parent's authority, including existing children.
  const parents =
    run.remoteRootTaskId && run.remoteRootTaskId !== run.taskId
      ? await prisma.run.findMany({
          where: { taskId: run.remoteRootTaskId, userId: run.userId, spaceId: run.spaceId },
        })
      : [];
  if (parents.some((parent) => parent.cancelRequestedAt)) throw new DispatchStopRequested();
  for (const id of new Set(
    [
      run.originDeviceGrantId,
      ...(run.remoteDeviceGrantIds ?? []),
      ...parents.flatMap((parent) => [parent.originDeviceGrantId, ...parent.remoteDeviceGrantIds]),
    ].filter((id): id is string => Boolean(id)),
  )) {
    const decision = await evaluateRemoteExecution(
      prisma,
      { ...run, originDeviceGrantId: id },
      tool,
    );
    if (!decision.allowed) return decision;
  }
  return { allowed: true as const };
}
/** Built-ins have a deployment-local resource boundary, just as connectors have a revisioned resource. */
export function remoteBuiltinApprovalRoute(
  run: { originDeviceGrantId?: string | null; botId: string },
  toolName: string,
  builtin: boolean,
): BoundApprovalRoute | undefined {
  return run.originDeviceGrantId && builtin
    ? { connectorId: "builtin", resourceId: run.botId, resourceRevision: 1, toolName }
    : undefined;
}
export function approvalRequestRoute(request: unknown): BoundApprovalRoute | undefined {
  return (
    boundDirectApprovalDetails(request, REMOTE_APPROVAL_MARKER)?.route ??
    catalogApprovalDetails(request, REMOTE_APPROVAL_MARKER)?.route
  );
}
export async function bindDeviceApproval(prisma: PrismaClient, run: Run, effect: ExternalEffect) {
  // Legacy envelopes without a resolved route are deliberately not promoted to remote approvals.
  if (!approvalRequestRoute(effect.request)) return;
  const home = await prisma.instanceIdentity.findUnique({ where: { id: "home" } });
  if (!home) return;
  return prisma.deviceApprovalBinding.upsert({
    where: { effectId: effect.id },
    create: {
      effectId: effect.id,
      instanceId: home.instanceId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      taskId: run.taskId,
      runId: run.id,
      originDeviceGrantId: run.originDeviceGrantId ?? "",
      requestFingerprint: deviceDigest(canonicalDispatchJson(effect.request)),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
    update: {},
  });
}
export type DeviceApprovalAnswer = Pick<
  DeviceApprovalBinding,
  "effectId" | "nonce" | "requestFingerprint"
> & { grantId: string; instanceId: string; decision?: "allow" | "deny" };
export async function validateDeviceApproval(
  tx: Prisma.TransactionClient,
  effect: { id: string; request: unknown; kind: string; runId: string },
  input: DeviceApprovalAnswer,
) {
  const fail = () =>
    new DeviceRequestError("This approval changed or expired; review it again at home.", 409);
  const [binding, grant, run] = await Promise.all([
    tx.deviceApprovalBinding.findUnique({ where: { effectId: effect.id } }),
    tx.deviceGrant.findFirst({
      where: { id: input.grantId, instanceId: input.instanceId, revokedAt: null },
    }),
    tx.run.findUnique({ where: { id: effect.runId } }),
  ]);
  const route = approvalRequestRoute(effect.request);
  if (!binding || !route)
    throw new DeviceRequestError("This older approval must be answered at home.");
  if (
    !grant ||
    (grant.kind === "channel" && binding.originDeviceGrantId !== grant.id) ||
    !run ||
    input.effectId !== effect.id ||
    binding.instanceId !== input.instanceId ||
    binding.spaceId !== grant.spaceId ||
    binding.userId !== grant.userId ||
    binding.runId !== run.id ||
    binding.taskId !== run.taskId ||
    binding.botId !== run.botId ||
    binding.answeredAt ||
    binding.executedAt ||
    binding.expiresAt <= new Date() ||
    binding.nonce !== input.nonce ||
    binding.requestFingerprint !== input.requestFingerprint ||
    binding.requestFingerprint !== deviceDigest(canonicalDispatchJson(effect.request))
  )
    throw fail();
  if (
    !effectiveRemoteAuthority(await loadRemoteAuthority(tx, grant, run.botId)).includes("approve")
  )
    throw new DeviceRequestError("Answer this approval at home.");
  if (
    grant.kind === "channel" &&
    (classifyRemoteTool(route.toolName) !== "ordinary" || remotePermissionExpansion(route.toolName))
  )
    throw new DeviceRequestError("Approve this on your Mac or phone.");
  if (input.decision !== "deny") {
    const decision = await evaluateRemoteExecution(
      tx as PrismaClient,
      { ...run, originDeviceGrantId: grant.id },
      route.toolName,
    );
    if (!decision.allowed) throw new DeviceRequestError(decision.reason);
  }
  if (route.connectorId === "mcp") {
    const assignment = await tx.botMcpServer.findFirst({
      where: {
        botId: run.botId,
        serverId: route.resourceId,
        spaceId: run.spaceId,
        userId: run.userId,
        server: { enabled: true },
      },
      include: { server: true },
    });
    if (!assignment || route.resourceRevision !== assignment.server.revision) throw fail();
    const detail = boundDirectApprovalDetails(effect.request, REMOTE_APPROVAL_MARKER);
    const catalog = catalogApprovalDetails(effect.request, REMOTE_APPROVAL_MARKER);
    const args = detail?.args ?? (catalog?.args.arguments as Record<string, unknown> | undefined);
    if (
      !args ||
      (await integrationApprovalDetailsForCall(tx as PrismaClient, route, run, args))?.approval ===
        "disabled"
    )
      throw fail();
  } else if (route.connectorId === "builtin") {
    if (route.resourceId !== run.botId || route.resourceRevision !== 1) throw fail();
  } else {
    // Connector adapters without a revocable resource/revision contract need a home review.
    throw new DeviceRequestError("Review this connector approval at home.");
  }
  const used = await tx.deviceApprovalBinding.updateMany({
    where: {
      effectId: effect.id,
      nonce: input.nonce,
      answeredAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { answeredAt: new Date(), answeredByGrantId: grant.id },
  });
  if (used.count !== 1) throw fail();
  await tx.run.update({
    where: { id: run.id },
    data: {
      originDeviceGrantId: run.originDeviceGrantId ?? grant.id,
      remoteRootTaskId: run.remoteRootTaskId ?? run.taskId,
      remoteDeviceGrantIds: [...new Set([...(run.remoteDeviceGrantIds ?? []), grant.id])],
    },
  });
  await auditDevice(
    tx,
    grant.kind === "channel" ? "approval.channel.answered" : "approval.device.answered",
    {
      instanceId: grant.instanceId,
      userId: grant.userId,
      spaceId: grant.spaceId,
      grantId: grant.id,
      taskId: run.taskId,
      effectId: effect.id,
    },
  );
}
export async function revalidateDeviceApprovalExecution(
  prisma: PrismaClient,
  effectId: string,
  runId: string,
  tool: string,
) {
  const binding = await prisma.deviceApprovalBinding.findUnique({ where: { effectId } });
  if (!binding?.answeredByGrantId) return;
  const effect = await prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } });
  if (
    binding.expiresAt <= new Date() ||
    binding.executedAt ||
    binding.runId !== runId ||
    binding.requestFingerprint !== deviceDigest(canonicalDispatchJson(effect.request))
  )
    throw new DeviceRequestError("This approval changed or expired; review it again at home.", 409);
  const decision = await currentRemoteDecision(prisma, runId, tool);
  if (!decision.allowed) throw new DeviceRequestError(decision.reason);
  const used = await prisma.deviceApprovalBinding.updateMany({
    where: { effectId, executedAt: null, expiresAt: { gt: new Date() } },
    data: { executedAt: new Date() },
  });
  if (used.count !== 1)
    throw new DeviceRequestError("This approval was already used; review it again at home.", 409);
}

/** Keep transport decisions out of the executor's tool implementations. */
export async function enforceRemoteExecution(input: {
  prisma: PrismaClient;
  runId: string;
  tool: string;
  pause: (reason: string, action: string) => Promise<void>;
}): Promise<boolean> {
  const decision = await currentRemoteDecision(input.prisma, input.runId, input.tool);
  if (decision.allowed) return true;
  await input.pause(decision.reason, decision.action);
  return false;
}

export function deviceThreadProjection(value: unknown, spaceId?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => deviceThreadProjection(item, spaceId));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, v]) => [
      key,
      record.kind === "ask" && key === "actions" && Array.isArray(v)
        ? v
            .filter((action) => action.id !== "always")
            .map((item) => deviceThreadProjection(item, spaceId))
        : key === "spaces" && spaceId && Array.isArray(v)
          ? v
              .filter((space) => space.id === spaceId)
              .map((item) => deviceThreadProjection(item, spaceId))
          : deviceThreadProjection(v, spaceId),
    ]),
  );
}
