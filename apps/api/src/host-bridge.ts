import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { HostOperation, HostRequest } from "@ardurbot/contracts/host-bridge";
import { HOST_FRAME_BYTES } from "@ardurbot/contracts/host-bridge";
import { RuntimePinSchema } from "@ardurbot/contracts/runtime-pins";
import type { PrismaClient } from "@ardurbot/db";
import type { HostWire } from "@ardurbot/host-runtime/bridge-wire";
import { receiveFrames, wsWire } from "@ardurbot/host-runtime/bridge-wire";
import { hostTokenMatches, hostWorkerToken } from "@ardurbot/host-runtime/worker-auth";
import { WebSocketServer } from "ws";
import { HostHub } from "./host-hub.js";
import { authorizeHostMcp } from "./host-mcp-authorization.js";

export function hostTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export class HostBridge {
  readonly hub: HostHub;
  private readonly settingsRequests = new Set<string>();
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
  async registrationFor(authorization: string | undefined) {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) return null;
    const registration = await this.prisma.hostRegistration.findUnique({
      where: { id: "default" },
    });
    if (!registration || !hostTokenMatches(hostTokenHash(token), registration.tokenHash))
      return null;
    const deployment = await this.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
    });
    return deployment?.ownerUserId === registration.userId ? registration : null;
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
  private async authorize(request: HostRequest, ownerId: string, generation: string) {
    if (request.scope.userId !== ownerId) return false;
    if ("serverId" in request.operation) {
      const [registration, deployment] = await Promise.all([
        this.prisma.hostRegistration.findUnique({ where: { id: "default" } }),
        this.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      ]);
      return (
        registration?.generation === generation &&
        registration.userId === ownerId &&
        deployment?.ownerUserId === ownerId &&
        authorizeHostMcp(this.prisma, request, this.settingsRequests.has(request.id))
      );
    }
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
  /** Settings grants are local to this API instance and cannot be claimed by a worker frame. */
  async result(operation: HostOperation, context: Partial<AdapterContext>): Promise<unknown> {
    if (
      !["mcp.tools", "mcp.status", "mcp.stop"].includes(operation.op) ||
      !context.spaceId ||
      !context.userId
    )
      throw new Error("This host operation requires an active bot run.");
    const id = randomUUID();
    const request: HostRequest = {
      v: 1,
      type: "request",
      id,
      scope: { userId: context.userId, spaceId: context.spaceId, botId: "settings", runId: id },
      operation,
    };
    this.settingsRequests.add(id);
    let value: unknown;
    let wire: HostWire | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        wire = {
          send: async (frame) => {
            if (frame.type === "stream") {
              if (frame.channel !== "result") throw new Error("Unexpected MCP response.");
              value = frame.data;
              await this.hub.fromWorker(wire!, { v: 1, type: "ack", id, seq: frame.seq });
            } else if (frame.type === "end") {
              if (frame.problem)
                reject(new Error("The host server is unavailable. Reconnect this computer."));
              else resolve(value);
            } else reject(new Error("Unexpected MCP response."));
          },
          close: () => reject(new Error("The host connection closed.")),
        };
        timer = setTimeout(() => {
          this.hub.cancel(id, wire!);
          reject(new Error("The host server did not respond."));
        }, 30_000);
        void this.hub.request(request, wire).catch(reject);
      });
    } finally {
      clearTimeout(timer);
      this.settingsRequests.delete(id);
      if (wire) this.hub.closeWorker(wire);
    }
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
