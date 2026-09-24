import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  ComputerRef,
} from "@ardurbot/adapter-kit";
import { IDE_FILE_BYTES } from "@ardurbot/contracts";
import type { HostFrame, HostHealth, HostRequest } from "@ardurbot/contracts/host-bridge";
import {
  HOST_FILE_BYTES,
  HOST_IN_FLIGHT,
  HOST_TOTAL_BYTES,
  HOST_WINDOW,
  HostRequestSchema,
  HostRuntimeEventSchema,
} from "@ardurbot/contracts/host-bridge";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import type { HostWire } from "./bridge-wire.js";
import { hostLostProblem } from "./bridge-wire.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { getHostEnvironment, inspectHostEnvironment } from "./host-environment.js";
import { confinedHostCwd } from "./host-policy.js";
import { ClaudeCodeRuntime, probeClaude } from "./runtimes/claude-code-runtime.js";
import { CodexAppServerRuntime, probeCodex } from "./runtimes/codex-app-server-runtime.js";
import type { NativeSpawn } from "./runtimes/native-process.js";
import { spawnNative } from "./runtimes/native-process.js";

type Active = {
  abort: AbortController;
  seq: number;
  ack: number;
  bytes: number;
  wake?: () => void;
  callbacks: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
};
export class HostAgent {
  private active = new Map<string, Active>();
  private seen = new Set<string>();
  private sandbox: DesktopSandboxProvider;
  private roots: string[] = [];
  constructor(
    private readonly config: { root: string; hostRoots: string[] },
    private readonly wire: HostWire,
    private readonly runtimes: Record<"claude-code" | "codex-app-server", AgentRuntime> = {
      "claude-code": new ClaudeCodeRuntime(),
      "codex-app-server": new CodexAppServerRuntime(),
    },
  ) {
    this.sandbox = new DesktopSandboxProvider({
      root: config.root,
      hostRoots: config.hostRoots,
      restricted: true,
    });
  }
  async initialize() {
    await getHostEnvironment();
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    this.roots = await Promise.all(this.config.hostRoots.map((root) => realpath(root)));
  }
  async health(): Promise<HostHealth> {
    const cwd = await confinedHostCwd(this.config.root, [this.config.root]);
    const start: NativeSpawn = (binary, args) => spawnNative(binary, args, cwd);
    const [claude, codex, environment] = await Promise.all([
      probeClaude(start),
      probeCodex(start),
      inspectHostEnvironment(getHostEnvironment(), false),
    ]);
    return {
      platform: process.platform as HostHealth["platform"],
      roots: this.roots,
      load: this.active.size,
      claude,
      codex,
      environment,
    };
  }
  async receive(frame: HostFrame) {
    if (frame.type === "request") {
      const request = HostRequestSchema.parse(frame);
      if (this.active.size >= HOST_IN_FLIGHT || this.seen.has(frame.id)) {
        await this.wire.send({
          v: 1,
          type: "end",
          id: frame.id,
          problem: hostLostProblem(frame, "Host service is busy."),
        });
        return;
      }
      if (this.seen.size >= 100_000) {
        this.close();
        this.wire.close();
        return;
      }
      this.seen.add(frame.id);
      const state: Active = {
        abort: new AbortController(),
        seq: -1,
        ack: -1,
        bytes: 0,
        callbacks: new Map(),
      };
      this.active.set(frame.id, state);
      void this.execute(request, state);
      return;
    }
    if (!("id" in frame)) throw new Error("Unexpected host request.");
    const state = this.active.get(frame.id);
    if (!state) return;
    if (frame.type === "cancel") {
      state.abort.abort();
      state.wake?.();
      return;
    }
    if (frame.type === "ack") {
      if (frame.seq <= state.ack || frame.seq > state.seq)
        throw new Error("Invalid host acknowledgement.");
      state.ack = frame.seq;
      state.wake?.();
      return;
    }
    if (frame.type === "reply") {
      const callback = state.callbacks.get(frame.callId);
      if (!callback) throw new Error("Unknown host callback.");
      state.callbacks.delete(frame.callId);
      if (frame.failed) callback.reject(new Error("Worker rejected the runtime callback."));
      else callback.resolve(frame.value);
      return;
    }
    throw new Error("Unexpected host request.");
  }
  close() {
    for (const state of this.active.values()) {
      state.abort.abort();
      state.wake?.();
      for (const callback of state.callbacks.values())
        callback.reject(new Error("Host connection closed."));
      state.callbacks.clear();
    }
  }
  private async execute(request: HostRequest, state: Active) {
    const timeout = setTimeout(() => {
      state.abort.abort();
      state.wake?.();
    }, 15 * 60_000);
    timeout.unref?.();
    const context: AdapterContext = {
      ...request.scope,
      operationId: request.id,
      traceId: request.id,
      signal: state.abort.signal,
    };
    const send = async (
      channel: "stdout" | "stderr" | "exit" | "event" | "file" | "result",
      data: unknown,
    ) => {
      while (state.seq - state.ack >= HOST_WINDOW && !state.abort.signal.aborted)
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
      state.abort.signal.throwIfAborted();
      state.bytes += Buffer.byteLength(JSON.stringify(data));
      if (state.bytes > HOST_TOTAL_BYTES) throw new Error("Host output limit reached.");
      await this.wire.send({
        v: 1,
        type: "stream",
        id: request.id,
        seq: ++state.seq,
        channel,
        data,
      });
    };
    try {
      const op = request.operation;
      if (op.op === "host.health") {
        await send("result", await this.health());
      } else {
        // Never accept providerRef or a computer home from the wire. The service owns this mapping.
        const computerKey = createHash("sha256")
          .update(request.scope.spaceId)
          .update("\0")
          .update(op.homeKey)
          .digest("hex");
        const computer = await this.sandbox.provision(
          { botId: computerKey, homePath: "" },
          context,
        );
        await confinedHostCwd(computer.providerRef, [this.config.root]);
        if (op.op === "computer.environment") {
          await send("result", await inspectHostEnvironment());
        } else if (op.op === "computer.exec") {
          if (op.cwd?.split(/[/\\]/u).includes(".."))
            throw new Error("Path escapes registered folders.");
          for await (const event of this.sandbox.execute(computer, op, context))
            await send(event.type, event.type === "exit" ? event.code : event.data);
        } else if (op.op === "computer.files.read") {
          const target = this.fileTarget(computer, op.path);
          const bytes = await this.sandbox.readFile(target.computer, target.path, context, {
            maxBytes: Math.min(
              op.maxBytes ?? HOST_FILE_BYTES,
              op.editor ? IDE_FILE_BYTES + 1 : HOST_FILE_BYTES,
            ),
            preview: op.editor === true,
          });
          for (let offset = 0; offset < bytes.length; offset += 32 * 1024)
            await send(
              "file",
              Buffer.from(bytes.subarray(offset, offset + 32 * 1024)).toString("base64"),
            );
        } else if (op.op === "computer.files.write") {
          const content = Buffer.from(op.content, "base64");
          if (content.byteLength > (op.editor ? IDE_FILE_BYTES : HOST_FILE_BYTES))
            throw new Error("Host file too large.");
          const target = this.fileTarget(computer, op.path);
          await this.sandbox.writeFile(target.computer, {
            path: target.path,
            content,
            executable: op.executable,
          });
        } else if (op.op === "computer.files.list") {
          const target = this.fileTarget(computer, op.path);
          const files = await this.sandbox.listFiles(target.computer, target.path, context);
          if (files.length > 2048) throw new Error("Host directory too large.");
          await send(
            "result",
            path.isAbsolute(op.path)
              ? files.map((file) => ({
                  ...file,
                  path: path.join(target.computer.providerRef, file.path),
                }))
              : files,
          );
        } else if (op.op === "computer.lifecycle") {
          if (op.action === "destroy") await this.sandbox.destroy(computer, context);
          else if (op.action === "sleep") await this.sandbox.stop(computer, context);
          else if (op.action === "cwd")
            await send("result", await this.sandbox.resolveCommandCwd(computer, op.cwd, context));
          else if (op.action === "snapshot")
            await send("result", await this.sandbox.snapshot(computer, context));
          else {
            await this.sandbox.prepare(computer, context);
            await send("result", { ...computer, botId: op.homeKey });
          }
        } else await this.turn(request, state, computer, context, send);
      }
      state.abort.signal.throwIfAborted();
      await this.wire.send({ v: 1, type: "end", id: request.id });
    } catch (error) {
      await this.wire
        .send({
          v: 1,
          type: "end",
          id: request.id,
          problem:
            error instanceof RuntimePinError
              ? error.problem
              : hostLostProblem(
                  request,
                  "Host operation could not finish — check registered folders and the runtime.",
                ),
        })
        .catch(() => this.wire.close());
    } finally {
      clearTimeout(timeout);
      state.abort.abort();
      state.wake?.();
      for (const cb of state.callbacks.values()) cb.reject(new Error("Host operation ended."));
      this.active.delete(request.id);
    }
  }
  private fileTarget(computer: ComputerRef, requested: string) {
    if (!path.isAbsolute(requested)) return { computer, path: requested === "." ? "" : requested };
    const root = [computer.providerRef, ...this.roots].find((root) => {
      const relative = path.relative(root, requested);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!root) throw new Error("Path escapes registered folders.");
    const key = `folder-${createHash("sha256").update(root).digest("hex")}`;
    // Only locally registered roots can create these provider references. The provider
    // resolves symlinks again at file-open time and uses its existing contained writer.
    return {
      computer: { ...computer, id: key, botId: key, providerRef: root },
      path: path.relative(root, requested),
    };
  }
  private async turn(
    request: HostRequest,
    state: Active,
    computer: ComputerRef,
    context: AdapterContext,
    send: (channel: "event", data: unknown) => Promise<void>,
  ) {
    if (request.operation.op !== "runtime.turn") return;
    const turn = request.operation.request;
    if (turn.runId !== request.scope.runId || turn.botId !== request.scope.botId)
      throw new Error("Runtime scope mismatch.");
    const kind = turn.model.runtimePin.runtimeKind;
    if (
      turn.model.provider !== turn.model.runtimePin.provider ||
      turn.model.id !== turn.model.runtimePin.modelId ||
      turn.model.thinkingLevel !== turn.model.runtimePin.effort
    )
      throw new Error("Runtime pin mismatch.");
    if (kind === "pi") throw new Error("Runtime is not a host runtime.");
    const callback = async (
      method:
        | "authorizeTool"
        | "executeTool"
        | "onToolCompleted"
        | "onRuntimeInfo"
        | "claimSteering",
      args: unknown[],
    ) => {
      state.abort.signal.throwIfAborted();
      if (state.callbacks.size >= HOST_WINDOW) throw new Error("Too many runtime callbacks.");
      const callId = randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const abort = () => {
          state.callbacks.delete(callId);
          reject(new Error("Host operation cancelled."));
        };
        state.abort.signal.addEventListener("abort", abort, { once: true });
        state.callbacks.set(callId, {
          resolve: (value) => {
            state.abort.signal.removeEventListener("abort", abort);
            resolve(value);
          },
          reject: (error) => {
            state.abort.signal.removeEventListener("abort", abort);
            reject(error);
          },
        });
        void this.wire
          .send({ v: 1, type: "callback", id: request.id, callId, method, args })
          .catch(abort);
      });
    };
    const nativeCwd = await confinedHostCwd(turn.nativeCwd ?? computer.providerRef, [
      computer.providerRef,
      ...this.roots,
    ]);
    const local: AgentRunRequest = {
      ...turn,
      nativeCwd,
      tools: turn.tools as AgentRunRequest["tools"],
      currentTurnImages: turn.currentTurnImages?.map((image) => ({
        ...image,
        data: Buffer.from(image.data, "base64"),
      })),
      authorizeTool: async (name) =>
        (await callback("authorizeTool", [name])) as Awaited<
          ReturnType<NonNullable<AgentRunRequest["authorizeTool"]>>
        >,
      executeTool: (name, args, executionId) => callback("executeTool", [name, args, executionId]),
      onToolCompleted: async (result) => {
        await callback("onToolCompleted", [
          { ...result, error: result.error ? "Tool failed." : undefined },
        ]);
      },
      onRuntimeInfo: async (info) => {
        await callback("onRuntimeInfo", [info]);
      },
      claimSteering: async (seen) =>
        (await callback("claimSteering", [seen])) as Awaited<
          ReturnType<NonNullable<AgentRunRequest["claimSteering"]>>
        >,
    };
    for await (const event of this.runtimes[kind].run(local, context))
      await send("event", HostRuntimeEventSchema.parse(event));
  }
}
