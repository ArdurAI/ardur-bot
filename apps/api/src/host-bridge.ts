import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type { BoardRun, BoardRunResult } from "@ardurbot/contracts/board";
import { BoardError, BoardRunResultSchema } from "@ardurbot/contracts/board";
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
import { authorizeHostMcp } from "./host-mcp-authorization.js";

export function hostTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export class HostBridge {
  readonly hub: HostHub;
  private readonly ownerBoardRequests = new Set<string>();
  private readonly ownerFiles = new WeakMap<HostRequest, Actor>();
  private readonly settingsRequests = new WeakSet<HostRequest>();
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
    if (request.operation.op === "board.run")
      return this.authorizeBoard(request, ownerId, generation);
    if (request.operation.op === "import.scan" || request.operation.op === "import.read") {
      // Owner settings jobs have no bot or run. An ordinary run cannot acquire this scope.
      if (request.scope.botId !== "owner-import" || !request.scope.runId.startsWith("import-"))
        return false;
      const [registration, deployment, member] = await Promise.all([
        this.prisma.hostRegistration.findUnique({ where: { id: "default" } }),
        this.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
        this.prisma.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: request.scope.spaceId, userId: ownerId } },
        }),
      ]);
      return (
        registration?.generation === generation &&
        registration.userId === ownerId &&
        deployment?.ownerUserId === ownerId &&
        member?.role === "owner"
      );
    }
    const [registration, deployment] = await Promise.all([
      this.prisma.hostRegistration.findUnique({ where: { id: "default" } }),
      this.prisma.deploymentSettings.findUnique({ where: { id: "default" } }),
    ]);
    if (
      registration?.generation !== generation ||
      registration.userId !== ownerId ||
      deployment?.ownerUserId !== ownerId
    )
      return false;
    const owner = this.ownerFiles.get(request);
    const settingsRequest = this.settingsRequests.has(request);
    if (owner || settingsRequest) {
      try {
        await requireMembership(this.prisma, request.scope.userId, request.scope.spaceId);
      } catch {
        return false;
      }
    }
    if (owner) {
      const op = request.operation;
      if (!op.op.startsWith("computer.files.") || !("path" in op)) return false;
      const paths = this.hub.health?.platform === "win32" ? path.win32 : path.posix;
      return (
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
    if ("serverId" in request.operation)
      return authorizeHostMcp(this.prisma, request, settingsRequest);
    const run = await this.prisma.run.findFirst({
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
    if (
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
      operation: HostOperationSchema.parse(operation),
    };
    this.settingsRequests.add(request);
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
      this.settingsRequests.delete(request);
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
            if (!worker)
              void this.prisma.hostRegistration
                .updateMany({
                  where: { id: "default", generation: registration!.generation },
                  data: { lastSeenAt: new Date() },
                })
                .catch(() => ws.close());
          });
          receiveFrames(
            ws,
            async (frame) => {
              if (worker) return this.hub.fromWorker(wire, frame);
              await this.hub.fromHost(wire, frame);
              if (frame.type === "health")
                await this.prisma.hostRegistration.updateMany({
                  where: { id: "default", generation: registration!.generation },
                  data: {
                    hostRoots: frame.health.roots,
                    platform: frame.health.platform,
                    name: frame.health.name,
                    lastSeenAt: new Date(),
                  },
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
