import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  ComputerRef,
  TerminalContext,
  TerminalOutput,
  TerminalProvider,
} from "@ardurbot/adapter-kit";
import {
  TERMINAL_FRAME_BYTES,
  TERMINAL_SESSION_LIMIT,
  validateTerminalSize,
} from "@ardurbot/contracts";
import type { HostTerminalAction } from "@ardurbot/contracts/host-bridge";
import { filterHostEnvironment } from "@ardurbot/contracts/host-environment";
import type { HostGuardrailConfig } from "./host-guardrails.js";
import { isGuardedPath, resolveGuardrailPaths } from "./host-guardrails.js";
import { confinedHostCwd } from "./host-policy.js";
import { RuntimeQueue } from "./runtimes/native-process.js";
import { waitForTerminalCleanup } from "./terminal-cleanup.js";

export interface HostTerminalProcess {
  write(bytes: Uint8Array): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  onData(listener: (bytes: Uint8Array) => void): () => void;
  onExit(listener: () => void): () => void;
  /** Resolve only once the entire process tree is dead. Failure must reject. */
  killTree(): Promise<void>;
}
export interface HostTerminalProcessFactory {
  spawn(
    shell: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    cols: number,
    rows: number,
  ): Promise<HostTerminalProcess>;
}
/** A platform adapter must apply these guards to the shell and all descendants. */
export type GuardedHostTerminalFactory = (guard: HostGuardrailConfig) => HostTerminalProcessFactory;

type Admission = {
  computer: ComputerRef;
  context: TerminalContext;
  cancelled: boolean;
  done: Promise<unknown>;
};
type Session = Admission & {
  process: HostTerminalProcess;
  queue: RuntimeQueue<TerminalOutput>;
  closing: boolean;
  teardown?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  dispose: (() => void)[];
};
const unavailable = () => new Error("Terminal lease is unavailable.");
function sameControl(a: TerminalContext, b: TerminalContext) {
  return (
    a.spaceId === b.spaceId &&
    a.userId === b.userId &&
    a.leaseId === b.leaseId &&
    a.fence === b.fence &&
    a.generation === b.generation &&
    a.workingRoot === b.workingRoot
  );
}

/** Owns processes, never authentication credentials, tickets, or caller environment overrides. */
export class HostTerminalProvider implements TerminalProvider {
  readonly hostGeneration = randomUUID();
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Set<Admission>();
  private stopped = false;
  private readonly revoked = new Map<string, number>();
  private readonly factory: HostTerminalProcessFactory;
  constructor(
    private readonly options: {
      factory: GuardedHostTerminalFactory;
      guard: HostGuardrailConfig;
      environment(): Promise<NodeJS.ProcessEnv>;
      generation?(computer: ComputerRef): string;
      shell?: string;
    },
  ) {
    this.factory = options.factory(options.guard);
  }
  async available() {
    return !this.stopped;
  }
  private leaseKey(computer: ComputerRef, context: AdapterContext, leaseId: string) {
    return JSON.stringify([computer.id, context.spaceId, context.userId, leaseId]);
  }
  open(
    computer: ComputerRef,
    options: { cols: number; rows: number; shellProfileId: string },
    context: TerminalContext,
  ) {
    validateTerminalSize(options.cols, options.rows);
    for (const [key, expiresAt] of this.revoked)
      if (expiresAt <= Date.now()) this.revoked.delete(key);
    const siblings = [...this.sessions.values(), ...this.pending].filter(
      (s) => s.computer.id === computer.id,
    );
    if (
      this.stopped ||
      this.revoked.size >= 10000 ||
      this.revoked.has(this.leaseKey(computer, context, context.leaseId)) ||
      context.signal.aborted ||
      context.expiresAt <= Date.now() ||
      !context.leaseId ||
      context.generation !== (this.options.generation?.(computer) ?? computer.providerRef) ||
      options.shellProfileId !== "default" ||
      siblings.length >= TERMINAL_SESSION_LIMIT ||
      this.sessions.size + this.pending.size >= 16 ||
      siblings.some(
        (s) => s.cancelled || ("closing" in s && s.closing) || !sameControl(s.context, context),
      )
    )
      return Promise.reject(unavailable());
    const admission: Admission = {
      computer,
      context: { ...context },
      cancelled: false,
      done: Promise.resolve(),
    };
    this.pending.add(admission);
    const opening = this.start(admission, options).finally(() => this.pending.delete(admission));
    admission.done = opening;
    return opening;
  }
  private async start(admission: Admission, options: { cols: number; rows: number }) {
    const { computer, context } = admission;
    const cwd = await confinedHostCwd(context.workingRoot, [computer.providerRef]);
    const guards = await resolveGuardrailPaths(this.options.guard.paths);
    if (isGuardedPath(guards, cwd))
      throw new Error("This path is protected by the host guardrail.");
    const env = filterHostEnvironment(await this.options.environment(), process.platform);
    const check = () => {
      if (
        this.stopped ||
        admission.cancelled ||
        context.signal.aborted ||
        context.expiresAt <= Date.now()
      )
        throw unavailable();
    };
    check();
    // Re-check Linux shell selection in step 3 before injecting a factory there.
    const shell =
      this.options.shell ??
      (process.platform === "win32"
        ? path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
        : env.SHELL && path.posix.isAbsolute(env.SHELL)
          ? env.SHELL
          : "/bin/sh");
    const child = await this.factory.spawn(
      shell,
      cwd,
      { ...env, TERM: "xterm-256color" },
      options.cols,
      options.rows,
    );
    const id = randomUUID();
    const session: Session = {
      ...admission,
      process: child,
      queue: new RuntimeQueue<TerminalOutput>(),
      closing: false,
      dispose: [],
    };
    this.sessions.set(id, session);
    try {
      check();
      let seq = 0;
      session.dispose.push(
        child.onData((bytes) => {
          if (session.closing || !bytes.length) return;
          for (let offset = 0; offset < bytes.length; offset += TERMINAL_FRAME_BYTES) {
            const error = session.queue.push({
              seq: ++seq,
              bytes: bytes.slice(offset, offset + TERMINAL_FRAME_BYTES),
            });
            if (error) {
              void this.close(id, "output-limit").catch(() => {});
              break;
            }
          }
        }),
      );
      session.dispose.push(
        child.onExit(() => {
          void this.close(id, "process-exited").catch(() => {});
        }),
      );
      session.timer = setTimeout(
        () => {
          void this.close(id, "expired").catch(() => {});
        },
        Math.min(context.expiresAt - Date.now(), 30 * 60_000),
      );
      session.timer.unref();
      check();
      return { id, generation: context.generation };
    } catch (error) {
      await this.close(id, "revoked-during-open");
      throw error;
    }
  }
  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.closing || session.context.expiresAt <= Date.now()) throw unavailable();
    return session;
  }
  async write(id: string, bytes: Uint8Array) {
    if (!bytes.length || bytes.length > TERMINAL_FRAME_BYTES)
      throw new Error("Terminal input exceeds limit.");
    await this.session(id).process.write(bytes);
  }
  async resize(id: string, cols: number, rows: number) {
    validateTerminalSize(cols, rows);
    await this.session(id).process.resize(cols, rows);
  }
  output(id: string) {
    return this.session(id).queue;
  }
  async close(id: string, _reason: string) {
    await this.waitForCleanup(this.teardown(id));
  }
  private teardown(id: string) {
    const session = this.sessions.get(id);
    if (!session) return Promise.resolve();
    session.closing = true;
    clearTimeout(session.timer);
    session.teardown ??= Promise.resolve().then(async () => {
      try {
        await session.process.killTree();
        for (const dispose of session.dispose) dispose();
        session.queue.end();
        this.sessions.delete(id);
      } catch (error) {
        session.teardown = undefined;
        console.error(`Terminal cleanup failed; remaining sessions: ${this.sessions.size}.`);
        throw error;
      }
    });
    return session.teardown;
  }
  private waitForCleanup(cleanup: Promise<unknown>) {
    return waitForTerminalCleanup(cleanup, () => {
      console.warn(`Terminal cleanup timed out; remaining sessions: ${this.sessions.size}.`);
    });
  }
  private async teardownAll(ids: string[]) {
    const results = await Promise.allSettled(ids.map((id) => this.teardown(id)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  async revoke(computer: ComputerRef, leaseId: string, context: AdapterContext) {
    if (leaseId !== "*")
      this.revoked.set(this.leaseKey(computer, context, leaseId), Date.now() + 30 * 60_000);
    const matches = (s: Admission) =>
      s.computer.id === computer.id &&
      s.context.spaceId === context.spaceId &&
      s.context.userId === context.userId &&
      (leaseId === "*" || s.context.leaseId === leaseId);
    const pending = [...this.pending].filter(matches);
    if (leaseId === "*")
      for (const s of [...pending, ...this.sessions.values()].filter(matches))
        this.revoked.set(
          this.leaseKey(computer, context, s.context.leaseId),
          Date.now() + 30 * 60_000,
        );
    for (const admission of pending) admission.cancelled = true;
    await this.waitForCleanup(
      Promise.all([
        this.teardownAll([...this.sessions].filter(([, s]) => matches(s)).map(([id]) => id)),
        ...pending.map((s) => s.done.catch(() => undefined)),
      ]),
    );
  }
  async closeAll() {
    this.stopped = true;
    for (const admission of this.pending) admission.cancelled = true;
    await this.waitForCleanup(
      Promise.all([
        this.teardownAll([...this.sessions.keys()]),
        ...[...this.pending].map((s) => s.done.catch(() => undefined)),
      ]),
    );
  }
  async call(
    computer: ComputerRef,
    action: HostTerminalAction,
    context: AdapterContext,
    send: (channel: "result", data: unknown) => Promise<void>,
  ) {
    if (action.hostGeneration !== this.hostGeneration) throw unavailable();
    if ("sessionId" in action) {
      const s = this.sessions.get(action.sessionId);
      if (!s && action.type === "close") return;
      if (
        !s ||
        s.computer.id !== computer.id ||
        s.context.spaceId !== context.spaceId ||
        s.context.userId !== context.userId ||
        s.context.leaseId !== action.leaseId ||
        s.context.fence !== action.fence ||
        s.context.generation !== action.generation ||
        s.context.expiresAt !== action.expiresAt
      )
        throw unavailable();
    }
    context.signal.throwIfAborted();
    switch (action.type) {
      case "cwd": {
        const cwd = await confinedHostCwd(path.resolve(computer.providerRef, action.cwd ?? ""), [
          computer.providerRef,
        ]);
        if (isGuardedPath(await resolveGuardrailPaths(this.options.guard.paths), cwd))
          throw unavailable();
        return send("result", cwd);
      }
      case "open": {
        const opened = await this.open(computer, action, { ...context, ...action });
        try {
          await send("result", opened);
        } catch (error) {
          await this.close(opened.id, "open-delivery-failed");
          throw error;
        }
        return;
      }
      case "write":
        return this.write(action.sessionId, Buffer.from(action.content, "base64"));
      case "resize":
        return this.resize(action.sessionId, action.cols, action.rows);
      case "close":
        return this.close(action.sessionId, "closed");
      case "revoke":
        return this.revoke(computer, action.leaseId, context);
      case "output":
        for await (const frame of this.output(action.sessionId)) {
          context.signal.throwIfAborted();
          await send("result", {
            seq: frame.seq,
            content: Buffer.from(frame.bytes).toString("base64"),
          });
        }
    }
  }
}
