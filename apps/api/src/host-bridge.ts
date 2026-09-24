import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { Actor } from "@ardurbot/contracts";
import type { HostOperation, HostRequest } from "@ardurbot/contracts/host-bridge";
import { HOST_WRITE_FRAME_BYTES, HostOperationSchema } from "@ardurbot/contracts/host-bridge";
import { RuntimePinSchema } from "@ardurbot/contracts/runtime-pins";
import type { PrismaClient } from "@ardurbot/db";
import { requireMembership } from "@ardurbot/db";
import type { HostWire } from "@ardurbot/host-runtime/bridge-wire";
import { receiveFrames, wsWire } from "@ardurbot/host-runtime/bridge-wire";
import { hostTokenMatches, hostWorkerToken } from "@ardurbot/host-runtime/worker-auth";
import { WebSocketServer } from "ws";
import { HostHub } from "./host-hub.js";

export function hostTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export class HostBridge {
  readonly hub: HostHub;
  private readonly ownerFiles = new WeakMap<HostRequest, Actor>();
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
  /** In-process grants cannot be supplied by a worker or a renderer. No bot run is fabricated. */
  async ownerFile(actor: Actor, operation: HostOperation, signal?: AbortSignal) {
    if (!actor.isDeploymentOwner || !operation.op.startsWith("computer.files."))
      throw new Error("Only the deployment owner can edit registered folders.");
    const id = randomUUID();
    const request: HostRequest = {
      v: 1,
      type: "request",
      id,
      scope: { userId: actor.userId, spaceId: actor.spaceId, botId: "ide", runId: id },
      operation: HostOperationSchema.parse(operation),
    };
    this.ownerFiles.set(request, actor);
    const chunks: Buffer[] = [];
    let result: unknown;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ended = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const worker: HostWire = {
      send: async (frame) => {
        if (frame.type === "end") {
          if (frame.problem) reject(new Error(frame.problem.reason));
          else resolve();
        } else if (frame.type === "stream") {
          if (frame.channel === "file" && typeof frame.data === "string")
            chunks.push(Buffer.from(frame.data, "base64"));
          else if (frame.channel === "result") result = frame.data;
          else throw new Error("Unexpected host file response.");
          await this.hub.fromWorker(worker, { v: 1, type: "ack", id, seq: frame.seq });
        }
      },
      close: () => reject(new Error("Host service disconnected.")),
    };
    const cancel = () => this.hub.cancel(id, worker);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      await Promise.all([this.hub.request(request, worker), ended]);
      return { bytes: new Uint8Array(Buffer.concat(chunks)), result };
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.hub.closeWorker(worker);
      this.ownerFiles.delete(request);
    }
  }
  private async authorize(request: HostRequest, ownerId: string, generation: string) {
    if (request.scope.userId !== ownerId) return false;
    const owner = this.ownerFiles.get(request);
    if (owner) {
      const [registration, deployment] = await Promise.all([
        this.prisma.hostRegistration.findUnique({ where: { id: "default" } }),
        this.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
        requireMembership(this.prisma, owner.userId, owner.spaceId),
      ]);
      const op = request.operation;
      if (!op.op.startsWith("computer.files.") || !("path" in op)) return false;
      const paths = this.hub.health?.platform === "win32" ? path.win32 : path.posix;
      return (
        registration?.generation === generation &&
        registration?.userId === ownerId &&
        deployment?.ownerUserId === ownerId &&
        paths.isAbsolute(op.path) &&
        registration.hostRoots.some((root) => {
          const relative = paths.relative(root, op.path);
          return (
            relative === "" ||
            (!relative.startsWith(`..${paths.sep}`) &&
              relative !== ".." &&
              !paths.isAbsolute(relative))
          );
        })
      );
    }
    if ("editor" in request.operation && request.operation.editor) return false;
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
      maxPayload: HOST_WRITE_FRAME_BYTES,
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
