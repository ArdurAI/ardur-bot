import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import type { HostOperation, HostRequest } from "@ardurbot/contracts/host-bridge";
import { HOST_FRAME_BYTES } from "@ardurbot/contracts/host-bridge";
import { RuntimePinSchema } from "@ardurbot/contracts/runtime-pins";
import type { PrismaClient } from "@ardurbot/db";
import { receiveFrames, wsWire } from "@ardurbot/host-runtime/bridge-wire";
import { isKubernetesMaintenanceCommand } from "@ardurbot/host-runtime/fleet/kubernetes-files";
import type { HostStreamFrame } from "@ardurbot/host-runtime/host-client";
import { RuntimeQueue } from "@ardurbot/host-runtime/runtimes/native-process";
import { hostTokenMatches, hostWorkerToken } from "@ardurbot/host-runtime/worker-auth";
import { WebSocketServer } from "ws";
import { HostHub } from "./host-hub.js";

export function hostTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export class HostBridge {
  readonly hub: HostHub;
  private readonly fleetRequests = new Map<string, string>();
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryptionKey: string,
  ) {
    this.hub = new HostHub((request, ownerId, generation) =>
      this.authorize(request, ownerId, generation),
    );
  }
  async pair(userId: string) {
    const deployment = await this.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
    });
    if (deployment?.ownerUserId !== userId)
      throw new Error("Only the deployment owner can connect this computer.");
    const token = randomBytes(32).toString("base64url");
    // Creation is deliberately not an upsert: a second desktop cannot silently replace the first.
    await this.prisma.hostRegistration.create({
      data: { id: "default", userId, tokenHash: hostTokenHash(token), generation: randomUUID() },
    });
    return { token };
  }
  async disconnect(userId: string) {
    await this.prisma.hostRegistration.deleteMany({ where: { id: "default", userId } });
    this.hub.detach();
    return { ok: true as const };
  }
  async status(userId: string) {
    const row = await this.prisma.hostRegistration.findUnique({ where: { id: "default" } });
    const configured = row?.userId === userId;
    return {
      configured,
      roots: configured ? row.hostRoots : [],
      connected: configured && this.hub.connected,
      health: configured ? this.hub.health : null,
    };
  }
  /** Only owner-authenticated API handlers mint setup requests; workers cannot mint these grants. */
  async *fleetRequest(
    operation: HostOperation,
    context: Partial<AdapterContext>,
  ): AsyncIterable<HostStreamFrame> {
    if (!context.userId || !context.spaceId) throw new Error("Owner context is required.");
    const request: HostRequest = {
      v: 1,
      type: "request",
      id: randomUUID(),
      scope: {
        userId: context.userId,
        spaceId: context.spaceId,
        botId: context.botId ?? "fleet",
        runId: context.runId ?? randomUUID(),
      },
      operation,
    };
    const queue = new RuntimeQueue<HostStreamFrame>();
    let ended = false;
    const wire = {
      send: async (frame: Parameters<HostHub["fromWorker"]>[1]) => {
        if (frame.type === "stream") queue.push(frame);
        else if (frame.type === "end") {
          ended = true;
          queue.end(
            frame.problem
              ? new Error("Host operation is unavailable; test the host connection.")
              : undefined,
          );
        }
      },
      close: () => queue.end(new Error("Host operation stopped.")),
    };
    if (!context.runId) this.fleetRequests.set(request.id, JSON.stringify(request));
    const abort = () => this.hub.cancel(request.id, wire);
    context.signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.hub.request(request, wire);
      for await (const frame of queue) {
        yield frame;
        await this.hub.fromWorker(wire, { v: 1, type: "ack", id: request.id, seq: frame.seq });
      }
    } finally {
      if (!ended) abort();
      context.signal?.removeEventListener("abort", abort);
      this.fleetRequests.delete(request.id);
    }
  }
  async fleetResult(operation: HostOperation, context: Partial<AdapterContext>) {
    let result: unknown;
    for await (const frame of this.fleetRequest(operation, context))
      if (frame.channel === "result") result = frame.data;
    return result;
  }
  private async authorize(request: HostRequest, ownerId: string, generation: string) {
    if (request.scope.userId !== ownerId) return false;
    if (
      request.operation.op.startsWith("computer.remote.") ||
      ("maintenanceId" in request.operation && !!request.operation.maintenanceId) ||
      this.fleetRequests.has(request.id)
    )
      return this.authorizeRemote(request, ownerId, generation);
    const [registration, deployment, run] = await Promise.all([
      this.prisma.hostRegistration.findUnique({ where: { id: "default" } }),
      this.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      this.prisma.run.findFirst({
        where: {
          id: request.scope.runId,
          botId: request.scope.botId,
          spaceId: request.scope.spaceId,
          userId: ownerId,
          status: "running",
          cancelRequestedAt: null,
        },
        include: { bot: { include: { computer: true } } },
      }),
    ]);
    if (
      registration?.generation !== generation ||
      registration?.userId !== ownerId ||
      deployment?.ownerUserId !== ownerId ||
      !run ||
      (run.bot.computer?.kind !== "desktop" &&
        (deployment.computerHost !== "this-mac" || run.bot.computer?.connectionId)) ||
      run.bot.spaceId !== request.scope.spaceId
    )
      return false;
    if ("homeKey" in request.operation && run.bot.computer?.homeKey !== request.operation.homeKey)
      return false;
    if (request.operation.op === "runtime.turn") {
      const turn = request.operation.request;
      if (
        turn.runId !== run.id ||
        turn.botId !== run.botId ||
        turn.threadId !== run.threadId ||
        JSON.stringify(RuntimePinSchema.parse(turn.model.runtimePin)) !==
          JSON.stringify(RuntimePinSchema.parse(run.runtimePin))
      )
        return false;
    }
    return true;
  }
  private async authorizeRemote(request: HostRequest, ownerId: string, generation: string) {
    const [registration, deployment, membership] = await Promise.all([
      this.prisma.hostRegistration.findUnique({ where: { id: "default" } }),
      this.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      this.prisma.spaceMember.findFirst({
        where: { spaceId: request.scope.spaceId, userId: ownerId },
      }),
    ]);
    if (
      registration?.generation !== generation ||
      registration.userId !== ownerId ||
      deployment?.ownerUserId !== ownerId ||
      !membership
    )
      return false;
    const op = request.operation;
    if (this.fleetRequests.get(request.id) === JSON.stringify(request)) return true;
    if (op.op === "computer.remote.secret" || op.op === "computer.remote.discover")
      return this.fleetRequests.get(request.id) === JSON.stringify(request);
    if (op.op !== "computer.remote.call") {
      if (!("maintenanceId" in op) || !op.maintenanceId || !("homeKey" in op)) return false;
      const bot = await this.prisma.bot.findFirst({
        where: { id: request.scope.botId, userId: ownerId, spaceId: request.scope.spaceId },
        include: { computer: true },
      });
      if (
        !bot?.computer ||
        bot.computer.homeKey !== op.homeKey ||
        bot.computer.connectionId ||
        bot.computer.maintenanceId !== op.maintenanceId
      )
        return false;
      const update = await this.prisma.computerUpdate.findFirst({
        where: {
          id: op.maintenanceId,
          computerId: bot.computer.id,
          botId: bot.id,
          status: "running",
        },
      });
      return (
        !!update &&
        (op.op !== "computer.exec" ||
          (op.argv[0] === "mkdir" &&
            op.argv[1] === "-p" &&
            op.argv.every((arg) => !arg.includes("..") && !arg.startsWith("/"))))
      );
    }
    const connection = await this.prisma.connection.findFirst({
      where: {
        id: op.connectionId,
        spaceId: request.scope.spaceId,
        userId: ownerId,
        connectorId: "computer",
        status: "connected",
      },
    });
    if (
      !connection ||
      JSON.stringify(ComputerConnectionSettingsSchema.parse(connection.metadata)) !==
        JSON.stringify(ComputerConnectionSettingsSchema.parse(op.settings))
    )
      return false;
    if (
      ["capacity", "test", "kube.capacity", "kube.namespaces", "kube.version"].includes(
        op.action.type,
      )
    )
      return true;
    const bot = await this.prisma.bot.findFirst({
      where: { id: request.scope.botId, userId: ownerId, spaceId: request.scope.spaceId },
      include: { computer: true },
    });
    const computer = bot?.computer;
    if (!computer || computer.homeKey !== op.homeKey || computer.connectionId !== op.connectionId)
      return false;
    if (op.action.type.startsWith("terminal.")) {
      if (!("leaseId" in op.action)) return false;
      if (
        op.action.type === "terminal.open" &&
        (op.action.fence !== computer.controlFence ||
          op.action.expiresAt > (computer.controlLeaseExpiresAt?.getTime() ?? 0))
      )
        return false;
      return (
        computer.controlBotId === bot.id &&
        computer.controlLeaseId === op.action.leaseId &&
        !!computer.controlLeaseExpiresAt &&
        computer.controlLeaseExpiresAt.getTime() > Date.now()
      );
    }
    if (op.maintenanceId && computer.maintenanceId === op.maintenanceId) {
      const update = await this.prisma.computerUpdate.findFirst({
        where: { id: op.maintenanceId, computerId: computer.id, botId: bot.id, status: "running" },
      });
      if (update)
        return (
          (op.action.type === "kube.exec"
            ? isKubernetesMaintenanceCommand(op.action.argv)
            : op.action.type !== "exec") ||
          (op.action.type === "exec" &&
            op.action.argv[0] === "mkdir" &&
            op.action.argv[1] === "-p" &&
            op.action.argv.every((arg) => !arg.includes("..") && !arg.startsWith("/")))
        );
    }
    const run = await this.prisma.run.findFirst({
      where: {
        id: request.scope.runId,
        botId: bot.id,
        userId: ownerId,
        spaceId: request.scope.spaceId,
        status: "running",
        cancelRequestedAt: null,
      },
    });
    if (run) return true;
    // Boot/file restoration is initiated by an owner API action before any run exists.
    return this.fleetRequests.get(request.id) === JSON.stringify(request);
  }
  isWorker(authorization: string | undefined) {
    return hostTokenMatches(authorization, `Bearer ${hostWorkerToken(this.encryptionKey)}`);
  }
  install(server: {
    on(
      event: "upgrade",
      handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): unknown;
  }) {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: HOST_FRAME_BYTES,
      perMessageDeflate: false,
    });
    server.on("upgrade", (request, socket, head) => {
      if (!["/api/host-bridge/socket", "/api/host-bridge/worker"].includes(request.url ?? ""))
        return;
      socket.pause();
      const timer = setTimeout(() => socket.destroy(), 5000);
      void (async () => {
        const worker = request.url === "/api/host-bridge/worker";
        const registration = worker
          ? null
          : await this.prisma.hostRegistration.findUnique({ where: { id: "default" } });
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        if (
          request.headers.origin ||
          (worker
            ? !this.isWorker(request.headers.authorization)
            : !registration ||
              !token ||
              !hostTokenMatches(hostTokenHash(token), registration.tokenHash))
        )
          throw new Error("Host authentication refused.");
        wss.handleUpgrade(request, socket, head, (ws) => {
          const wire = wsWire(ws);
          const detach = worker
            ? () => this.hub.closeWorker(wire)
            : this.hub.attach(wire, registration!.userId, registration!.generation);
          let alive = true;
          const heartbeat = setInterval(() => {
            if (!alive) ws.terminate();
            else {
              alive = false;
              ws.ping();
            }
          }, 15_000);
          heartbeat.unref();
          ws.on("pong", () => {
            alive = true;
          });
          receiveFrames(
            ws,
            async (frame) => {
              if (worker) return this.hub.fromWorker(wire, frame);
              await this.hub.fromHost(wire, frame);
              if (frame.type === "health")
                await this.prisma.hostRegistration.updateMany({
                  where: { id: "default", generation: registration!.generation },
                  data: { hostRoots: frame.health.roots },
                });
            },
            () => {
              clearInterval(heartbeat);
              detach();
            },
          );
        });
      })()
        .catch(() => {
          if (!socket.destroyed)
            socket.end(
              "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
        })
        .finally(() => {
          clearTimeout(timer);
          socket.resume();
        });
    });
  }
}
