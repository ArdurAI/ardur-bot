import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ComputerRef, TerminalContext, TerminalProvider } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  parseTerminalControl,
  TERMINAL_ENDED,
  TERMINAL_GRACE_MS,
  TERMINAL_REPLAY_BYTES,
  TERMINAL_WINDOW_BYTES,
} from "@ardurbot/contracts";

export type TerminalGrant = {
  actor: Actor;
  botId: string;
  computerId: string;
  computerGeneration: number;
  authSessionId: string;
  computer: ComputerRef;
  context: TerminalContext;
};
export type TerminalAuditType =
  | "requested"
  | "opened"
  | "denied"
  | "reconnected"
  | "revoked"
  | "closed";
export interface TerminalSocket {
  send(data: string | Uint8Array): Promise<void>;
  close(): void;
}
type Entry = {
  id: string;
  grant: TerminalGrant;
  origin: string;
  output: Array<{ seq: number; bytes: Uint8Array }>;
  retained: number;
  seq: number;
  ack: number;
  sent: number;
  input: number;
  socket?: TerminalSocket;
  closed: boolean;
  wake?: () => void;
  grace?: ReturnType<typeof setTimeout>;
  monitor?: ReturnType<typeof setInterval>;
  monitoring?: boolean;
  pumping: boolean;
  attachments: number;
  writing?: Promise<void>;
  resize?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>;
};
type Ticket = { session: Entry; expires: number };
export interface TerminalGatewayDeps {
  provider: TerminalProvider;
  authorize(grant: TerminalGrant): Promise<void>;
  audit(
    type: TerminalAuditType,
    grant: TerminalGrant,
    sessionId: string,
    reason: string,
  ): Promise<void>;
  now?: () => number;
}

/** All retained bytes are volatile. Audits contain references and fixed reasons only. */
export class TerminalGateway {
  readonly sessions = new Map<string, Entry>();
  private tickets = new Map<string, Ticket>();
  private readonly now: () => number;
  constructor(private readonly deps: TerminalGatewayDeps) {
    this.now = deps.now ?? Date.now;
  }
  async request(grant: TerminalGrant, origin: string, sessionId?: string) {
    await this.deps.audit("requested", grant, sessionId ?? "", "human-request");
    try {
      await this.deps.authorize(grant);
      if (sessionId) {
        const s = this.sessions.get(sessionId);
        if (!s || s.closed || s.origin !== origin || !sameGrant(s.grant, grant))
          throw new Error(TERMINAL_ENDED);
        return this.issue(s);
      }
      if ([...this.sessions.values()].some((s) => s.grant.computerId === grant.computerId))
        throw new Error("A terminal is already open.");
      const opened = await this.deps.provider.open(
        grant.computer,
        { cols: 80, rows: 24, shellProfileId: "default" },
        grant.context,
      );
      if (opened.generation !== grant.context.generation) {
        await this.deps.provider.close(opened.id, "stale-generation");
        throw new Error(TERMINAL_ENDED);
      }
      const s: Entry = {
        id: opened.id,
        grant,
        origin,
        output: [],
        retained: 0,
        seq: 0,
        ack: 0,
        sent: 0,
        input: 0,
        closed: false,
        pumping: false,
        attachments: 0,
      };
      this.sessions.set(s.id, s);
      try {
        await this.deps.audit("opened", grant, s.id, "human-control");
      } catch (error) {
        await this.close(s, "audit-failed");
        throw error;
      }
      this.armGrace(s);
      s.monitor = setInterval(() => {
        if (s.monitoring || s.closed) return;
        s.monitoring = true;
        void this.validate(s)
          .catch(() => {})
          .finally(() => {
            s.monitoring = false;
          });
      }, 1_000);
      s.monitor.unref?.();
      void this.collect(s);
      return this.issue(s);
    } catch {
      await this.deps.audit("denied", grant, sessionId ?? "", "authorization-or-session");
      throw new Error(TERMINAL_ENDED);
    }
  }
  private issue(s: Entry) {
    for (const [key, value] of this.tickets)
      if (value.expires <= this.now() || value.session === s) this.tickets.delete(key);
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(hash(ticket), {
      session: s,
      expires: Math.min(this.now() + 15_000, s.grant.context.expiresAt),
    });
    return { sessionId: s.id, ticket, path: "/api/terminal/socket" };
  }
  async attach(ticket: string, origin: string, ack: number, socket: TerminalSocket) {
    const key = hash(ticket),
      found = this.tickets.get(key);
    this.tickets.delete(key);
    if (!found || found.expires <= this.now() || found.session.origin !== origin)
      throw new Error(TERMINAL_ENDED);
    const s = found.session;
    await this.validate(s);
    if (s.socket) throw new Error("Terminal already attached.");
    if (
      !Number.isSafeInteger(ack) ||
      ack < s.ack ||
      ack > s.sent ||
      (s.output.length && ack < s.output[0]!.seq - 1)
    ) {
      await this.close(s, "replay-gap");
      throw new Error(TERMINAL_ENDED);
    }
    await s.writing;
    if (s.closed || s.socket) throw new Error(TERMINAL_ENDED);
    // Reserve the writable attachment before the audit await.
    s.socket = socket;
    clearTimeout(s.grace);
    if (s.attachments++) {
      try {
        await this.deps.audit("reconnected", s.grant, s.id, "new-ticket");
      } catch {
        await this.close(s, "audit-failed");
        throw new Error(TERMINAL_ENDED);
      }
    }
    s.ack = ack;
    s.sent = ack;
    await socket.send(JSON.stringify({ type: "ready", inputSeq: s.input }));
    s.wake?.();
    void this.flush(s);
    return {
      receive: async (data: string | Uint8Array) => {
        if (s.socket !== socket) throw new Error(TERMINAL_ENDED);
        await this.validate(s);
        if (s.socket !== socket) throw new Error(TERMINAL_ENDED);
        if (typeof data !== "string") {
          const frame = decodeTerminalFrame(data);
          if (frame.seq !== s.input + 1) throw new Error("Duplicate terminal input.");
          // Reserve before awaiting the provider: uncertain writes are never retried.
          s.input = frame.seq;
          s.writing = this.deps.provider.write(s.id, frame.bytes);
          await s.writing;
          return;
        }
        const frame = parseTerminalControl(data);
        if (frame.type === "ack") {
          if (frame.seq < s.ack || frame.seq > s.sent) throw new Error("Invalid acknowledgement.");
          s.ack = frame.seq;
          s.wake?.();
          void this.flush(s);
        } else if (frame.type === "resize") {
          clearTimeout(s.resize);
          s.resize = setTimeout(() => {
            void this.validate(s)
              .then(() => this.deps.provider.resize(s.id, frame.cols, frame.rows))
              .catch(() => this.close(s, "resize-failed"));
          }, 50);
        } else if (frame.type === "close") await this.close(s, "human-closed");
        else await socket.send(JSON.stringify({ type: "pong" }));
      },
      detach: () => {
        if (s.socket !== socket || s.closed) return;
        s.socket = undefined;
        this.armGrace(s);
        s.wake?.();
      },
    };
  }
  private async validate(s: Entry) {
    if (s.closed) throw new Error(TERMINAL_ENDED);
    try {
      if (s.grant.context.expiresAt <= this.now()) throw new Error("expired");
      await this.deps.authorize(s.grant);
    } catch {
      await this.close(s, "revoked", true);
      throw new Error(TERMINAL_ENDED);
    }
    if (s.closed) throw new Error(TERMINAL_ENDED);
  }
  private armGrace(s: Entry) {
    clearTimeout(s.grace);
    s.grace = setTimeout(
      () => {
        void this.close(s, "disconnected").catch(() => {});
      },
      Math.max(0, Math.min(TERMINAL_GRACE_MS, s.grant.context.expiresAt - this.now())),
    );
    s.grace.unref?.();
  }
  private outstanding(s: Entry) {
    return s.output.filter((f) => f.seq > s.ack).reduce((n, f) => n + f.bytes.length, 0);
  }
  private async collect(s: Entry) {
    try {
      const source = this.deps.provider.output(s.id)[Symbol.asyncIterator]();
      while (!s.closed) {
        // Pull only while there is space for another maximum-size frame.
        while (!s.closed && this.outstanding(s) > TERMINAL_WINDOW_BYTES - 64 * 1024)
          await new Promise<void>((resolve) => {
            s.wake = resolve;
          });
        if (s.closed) break;
        const next = await source.next();
        if (next.done || s.closed) break;
        const frame = next.value;
        if (frame.seq !== s.seq + 1 || !frame.bytes.length || frame.bytes.length > 64 * 1024)
          throw new Error("Invalid output sequence.");
        s.seq = frame.seq;
        s.output.push({ seq: frame.seq, bytes: frame.bytes.slice() });
        s.retained += frame.bytes.length;
        while (s.retained > TERMINAL_REPLAY_BYTES) {
          const first = s.output.shift()!;
          if (first.seq > s.ack) throw new Error("Replay overflow.");
          s.retained -= first.bytes.length;
        }
        await this.flush(s);
      }
      if (!s.closed) await this.close(s, "process-exited");
    } catch {
      if (!s.closed) await this.close(s, "process-ended").catch(() => {});
    }
  }
  private async flush(s: Entry) {
    if (s.pumping || !s.socket || s.closed) return;
    s.pumping = true;
    try {
      while (s.socket && !s.closed) {
        const frame = s.output.find((f) => f.seq > s.sent);
        if (!frame) break;
        const socket = s.socket;
        s.sent = frame.seq;
        await socket.send(encodeTerminalFrame(frame.seq, frame.bytes));
      }
    } catch {
      s.socket?.close();
      s.socket = undefined;
      this.armGrace(s);
    } finally {
      s.pumping = false;
    }
  }
  async close(s: Entry, reason: string, revoked = false): Promise<void> {
    s.closed = true;
    s.wake?.();
    clearTimeout(s.grace);
    clearTimeout(s.resize);
    clearInterval(s.monitor);
    s.socket?.close();
    s.socket = undefined;
    for (const [key, value] of this.tickets) if (value.session === s) this.tickets.delete(key);
    if (s.cleanup) return s.cleanup;
    s.cleanup = (async () => {
      try {
        if (revoked) await this.deps.audit("revoked", s.grant, s.id, reason);
      } finally {
        await this.deps.provider.close(s.id, reason);
      }
      await this.deps.audit("closed", s.grant, s.id, reason);
      s.output = [];
      s.retained = 0;
      this.sessions.delete(s.id);
    })();
    try {
      await s.cleanup;
    } catch (error) {
      s.cleanup = undefined;
      throw error;
    }
  }
  async closeOwned(actor: Actor, botId: string, computerId: string, sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (
      s.grant.actor.userId !== actor.userId ||
      s.grant.actor.spaceId !== actor.spaceId ||
      s.grant.botId !== botId ||
      s.grant.computerId !== computerId
    )
      throw new Error(TERMINAL_ENDED);
    await this.close(s, "human-closed");
  }
  async revokeUser(userId: string) {
    await Promise.all(
      [...this.sessions.values()]
        .filter((s) => s.grant.actor.userId === userId)
        .map((s) => this.close(s, "logout", true)),
    );
  }
  async stop() {
    await Promise.all(
      [...this.sessions.values()].map((s) => this.close(s, "server-stopped", true)),
    );
  }
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function sameGrant(a: TerminalGrant, b: TerminalGrant) {
  return (
    a.actor.userId === b.actor.userId &&
    a.actor.spaceId === b.actor.spaceId &&
    a.botId === b.botId &&
    a.computerId === b.computerId &&
    a.computerGeneration === b.computerGeneration &&
    a.authSessionId === b.authSessionId &&
    a.context.leaseId === b.context.leaseId &&
    a.context.fence === b.context.fence &&
    a.context.generation === b.context.generation
  );
}
export const terminalRequestReference = () => randomUUID();
