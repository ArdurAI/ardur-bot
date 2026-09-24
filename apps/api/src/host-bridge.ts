import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BoardRun, BoardRunResult } from "@ardurbot/contracts/board";
import { BoardError, BoardRunResultSchema } from "@ardurbot/contracts/board";
import type { HostRequest } from "@ardurbot/contracts/host-bridge";
import { HOST_FRAME_BYTES } from "@ardurbot/contracts/host-bridge";
import { RuntimePinSchema } from "@ardurbot/contracts/runtime-pins";
import type { PrismaClient } from "@ardurbot/db";
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
  private readonly ownerBoardRequests = new Set<string>();
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
  async runBoard(
    input: BoardRun,
    scope: { userId: string; spaceId: string; signal?: AbortSignal },
  ): Promise<BoardRunResult> {
    const id = randomUUID();
    const request: HostRequest = {
      v: 1,
      type: "request",
      id,
      scope: { userId: scope.userId, spaceId: scope.spaceId, botId: "board", runId: id },
      operation: { op: "board.run", request: input },
    };
    this.ownerBoardRequests.add(id);
    let wire: HostWire | undefined;
    const abort = () => {
      if (wire) this.hub.cancel(id, wire);
    };
    try {
      scope.signal?.throwIfAborted();
      return await new Promise<BoardRunResult>((resolve, reject) => {
        let stdout = "";
        let result: BoardRunResult | undefined;
        wire = {
          close: () =>
            reject(
              new BoardError({
                code: "command_failed",
                message: "Open the desktop app to use this board.",
              }),
            ),
          send: async (frame) => {
            if (frame.type === "stream") {
              if (frame.channel === "stdout") stdout += String(frame.data);
              if (frame.channel === "result") result = BoardRunResultSchema.parse(frame.data);
              await this.hub.fromWorker(wire!, { v: 1, type: "ack", id, seq: frame.seq });
            } else if (frame.type === "end") {
              if (frame.problem || !result)
                reject(
                  new BoardError({
                    code: "command_failed",
                    message: "Open the desktop app to use this board.",
                  }),
                );
              else resolve(result.ok && stdout ? { ...result, stdout } : result);
            }
          },
        };
        scope.signal?.addEventListener("abort", abort, { once: true });
        void this.hub.request(request, wire).catch(reject);
      });
    } finally {
      this.ownerBoardRequests.delete(id);
      scope.signal?.removeEventListener("abort", abort);
      if (wire) this.hub.closeWorker(wire);
    }
  }
  private async authorizeBoard(request: HostRequest, ownerId: string, generation: string) {
    if (request.operation.op !== "board.run") return false;
    const op = request.operation.request;
    const [registration, deployment, member] = await Promise.all([
      this.prisma.hostRegistration.findUnique({ where: { id: "default" } }),
      this.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
      this.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: request.scope.spaceId, userId: ownerId } },
      }),
    ]);
    if (
      registration?.generation !== generation ||
      registration.userId !== ownerId ||
      deployment?.ownerUserId !== ownerId ||
      !member
    )
      return false;
    const manual = this.ownerBoardRequests.has(request.id);
    if (manual) {
      const user = await this.prisma.user.findUnique({
        where: { id: ownerId },
        select: { name: true },
      });
      if (op.actor !== (user?.name.trim() || "Owner")) return false;
    } else {
      if (op.action === "export" || (op.action === "init" && op.workspace?.kind !== "space"))
        return false;
      let run = await this.prisma.run.findFirst({
        where: {
          id: request.scope.runId,
          botId: request.scope.botId,
          spaceId: request.scope.spaceId,
          userId: ownerId,
          status: "running",
          cancelRequestedAt: null,
        },
        include: { bot: { include: { computer: true } } },
      });
      if (!run) {
        run = await this.prisma.run.findFirst({
          where: {
            id: request.scope.runId,
            botId: request.scope.botId,
            spaceId: request.scope.spaceId,
            userId: ownerId,
            status: { in: ["completed", "failed", "cancelled"] },
            boardCommentedAt: null,
          },
          include: { bot: { include: { computer: true } } },
        });
        if (!run?.boardItemId || op.action !== "command" || op.workspaceId !== run.boardWorkspaceId)
          return false;
        const argv = op.argv;
        const read =
          JSON.stringify(argv) ===
            JSON.stringify([
              "show",
              "--include-comments",
              "--include-dependents",
              run.boardItemId,
            ]) ||
          JSON.stringify(argv) === JSON.stringify(["history", run.boardItemId, "--limit", "100"]);
        const comment =
          argv.length === 5 &&
          argv[0] === "comments" &&
          argv[1] === "add" &&
          argv[2] === "--" &&
          argv[3] === run.boardItemId &&
          argv[4]?.startsWith(`[Run ${run.id}] `);
        const close =
          run.status === "completed" &&
          run.boardCloseWhenDone &&
          JSON.stringify(argv) ===
            JSON.stringify(["close", run.boardItemId, "--reason", "Bot reported done"]);
        if (!read && !comment && !close) return false;
      }
      if (
        !run ||
        run.bot.spaceId !== request.scope.spaceId ||
        op.actor !== `bot:${run.bot.name}` ||
        (run.bot.computer?.kind !== "desktop" &&
          (deployment.computerHost !== "this-mac" || run.bot.computer?.connectionId))
      )
        return false;
    }
    if (op.action === "discover") return true;
    if (!op.workspaceId || !op.workspace) return false;
    const workspace = await this.prisma.boardWorkspace.findFirst({
      where: {
        id: op.workspaceId,
        spaceId: request.scope.spaceId,
        ownerUserId: ownerId,
        enabled: true,
      },
    });
    if (
      !workspace ||
      workspace.kind !== op.workspace.kind ||
      (op.action === "init" && workspace.prefix !== op.prefix)
    )
      return false;
    return (
      op.workspace.kind === "space" ||
      (op.workspace.path === workspace.path && registration.hostRoots.includes(workspace.path))
    );
  }
  private async authorize(request: HostRequest, ownerId: string, generation: string) {
    if (request.scope.userId !== ownerId) return false;
    if (request.operation.op === "board.run")
      return this.authorizeBoard(request, ownerId, generation);
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
