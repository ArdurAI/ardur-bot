import { randomUUID } from "node:crypto";
import { encodeTerminalFrame, TERMINAL_FRAME_BYTES, validateTerminalSize } from "@ardurbot/core";
import type Docker from "dockerode";
import type { Hono } from "hono";
import { z } from "zod";
import type { TerminalProcess } from "./terminal-process.js";
import { assertNoDockerTerminals, openDockerTerminal } from "./terminal-process.js";

type Grant = {
  startedAt?: string;
  leaseId: string;
  fence: number;
  generation: string;
  expiresAt: number;
  workingRoot: string;
  cols: number;
  rows: number;
  shellProfileId: string;
};
type Session = {
  id: string;
  computer: string;
  grant: Grant;
  process?: TerminalProcess;
  iterator?: AsyncIterator<Buffer>;
  seq: number;
  pending?: Buffer;
  reading: boolean;
  closing: boolean;
  cleanup?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  ready: Promise<void>;
};

export class TerminalRegistry {
  readonly sessions = new Map<string, Session>();
  private fences = new Map<string, number>();
  private commands = new Map<string, number>();
  constructor(private readonly now = Date.now) {}
  async command<T>(computer: string, work: () => Promise<T>): Promise<T> {
    if ([...this.sessions.values()].some((s) => s.computer === computer))
      throw new Error("A person has control of this computer; wait until they release it.");
    this.commands.set(computer, (this.commands.get(computer) ?? 0) + 1);
    try {
      return await work();
    } finally {
      this.commands.set(computer, this.commands.get(computer)! - 1);
    }
  }
  async open(computer: string, grant: Grant, spawn: (id: string) => Promise<TerminalProcess>) {
    validateTerminalSize(grant.cols, grant.rows);
    if (
      grant.shellProfileId !== "default" ||
      grant.expiresAt <= this.now() ||
      grant.expiresAt > this.now() + 24 * 60 * 60_000 ||
      !Number.isSafeInteger(grant.fence) ||
      grant.fence <= (this.fences.get(computer) ?? -1)
    )
      throw new Error("Stale terminal grant.");
    if (
      this.commands.get(computer) ||
      [...this.sessions.values()].some((s) => s.computer === computer)
    )
      throw new Error("Computer is busy.");
    const id = randomUUID();
    let resolveReady = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const session: Session = { id, computer, grant, seq: 0, reading: false, closing: false, ready };
    this.sessions.set(id, session);
    this.fences.set(computer, grant.fence);
    try {
      session.process = await spawn(id);
      session.iterator = session.process.stream[Symbol.asyncIterator]();
      session.process.stream.on("error", () => {
        void this.close(id).catch(() => {});
      });
      session.timer = setTimeout(
        () => {
          void this.close(id).catch(() => {});
        },
        Math.max(0, grant.expiresAt - this.now()),
      );
      session.timer.unref?.();
      return { id, generation: grant.generation };
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    } finally {
      resolveReady();
    }
  }
  current(id: string, computer: string, generation?: string) {
    const s = this.sessions.get(id);
    if (
      !s ||
      s.computer !== computer ||
      s.closing ||
      s.grant.expiresAt <= this.now() ||
      (generation && s.grant.generation !== generation)
    )
      throw new Error("Terminal session ended.");
    return s;
  }
  async read(id: string, computer: string) {
    const s = this.current(id, computer);
    if (s.reading) throw new Error("Terminal already attached.");
    s.reading = true;
    try {
      const item = s.pending ? { value: s.pending, done: false } : await s.iterator!.next();
      if (item.done) {
        await this.close(id);
        return null;
      }
      const bytes = Buffer.from(item.value);
      s.pending =
        bytes.length > TERMINAL_FRAME_BYTES ? bytes.subarray(TERMINAL_FRAME_BYTES) : undefined;
      return encodeTerminalFrame(++s.seq, bytes.subarray(0, TERMINAL_FRAME_BYTES));
    } finally {
      s.reading = false;
    }
  }
  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.closing = true;
    clearTimeout(s.timer);
    if (s.cleanup) return s.cleanup;
    s.cleanup = (async () => {
      await s.ready;
      await s.process?.close();
      this.sessions.delete(id);
    })();
    try {
      await s.cleanup;
    } catch (error) {
      s.cleanup = undefined;
      throw error;
    }
  }
  async revoke(computer: string, lease: string) {
    await Promise.all(
      [...this.sessions.values()]
        .filter((s) => s.computer === computer && s.grant.leaseId === lease)
        .map((s) => this.close(s.id)),
    );
  }
}

const grantSchema = z
  .object({
    leaseId: z.string().uuid(),
    fence: z.number().int().nonnegative(),
    generation: z.string().max(256),
    expiresAt: z.number().int(),
    workingRoot: z.string().max(512),
    cols: z.number(),
    rows: z.number(),
    shellProfileId: z.literal("default"),
  })
  .strict();
export function mountTerminalRoutes(
  app: Hono,
  registry: TerminalRegistry,
  managed: (
    id: string,
    bot?: string,
    space?: string,
  ) => Promise<{ container: Docker.Container; info: Docker.ContainerInspectInfo }>,
) {
  // Mounted behind the supervisor's bearer and computer identity middleware.
  app.post("/computers/:id/terminal/*", async (c) => {
    try {
      const computer = c.req.param("id");
      const { container, info } = await managed(
        computer,
        c.req.header("x-ardurbot-bot-id"),
        c.req.header("x-ardurbot-space-id"),
      );
      const action = c.req.path.split("/terminal/")[1]!;
      if (action === "open") {
        await assertNoDockerTerminals(container);
        const grant = grantSchema.parse(await c.req.json());
        if (
          !info.State.Running ||
          !info.Config.User ||
          /^(?:0|root)(?::|$)/.test(info.Config.User) ||
          grant.generation !== info.Id
        )
          throw new Error("Stale computer.");
        const screenId = c.req.header("x-ardurbot-screen-id");
        if (
          grant.workingRoot !== "/home/ardurbot" &&
          grant.workingRoot !== `/home/ardurbot/bots/${screenId}`
        )
          throw new Error("Invalid working root.");
        return c.json(
          await registry.open(computer, { ...grant, startedAt: info.State.StartedAt }, (id) =>
            openDockerTerminal(
              container,
              info.Config.User,
              grant.workingRoot,
              id,
              grant.cols,
              grant.rows,
              grant.expiresAt,
            ),
          ),
        );
      }
      if (action === "revoke") {
        const { leaseId } = z.object({ leaseId: z.string().uuid() }).parse(await c.req.json());
        await registry.revoke(computer, leaseId);
        if (![...registry.sessions.values()].some((session) => session.computer === computer))
          await assertNoDockerTerminals(container, true);
        return c.json({ ok: true });
      }
      const [id, operation] = action.split("/");
      if (!id) throw new Error("Missing session.");
      if (operation === "close") {
        const s = registry.sessions.get(id);
        if (s && s.computer !== computer) throw new Error("Wrong computer.");
        await registry.close(id);
        return c.json({ ok: true });
      }
      const s = registry.current(id, computer, info.Id);
      if (s.grant.startedAt !== info.State.StartedAt) {
        await registry.close(id);
        throw new Error("Stale computer.");
      }
      if (operation === "read") {
        const frame = await registry.read(id, computer);
        return frame
          ? new Response(Buffer.from(frame), {
              headers: { "content-type": "application/octet-stream" },
            })
          : c.body(null, 204);
      }
      if (operation === "write") {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (!bytes.length || bytes.length > TERMINAL_FRAME_BYTES) throw new Error("Invalid input.");
        registry.current(id, computer, info.Id);
        await new Promise<void>((resolve, reject) =>
          s.process!.stream.write(bytes, (error) => (error ? reject(error) : resolve())),
        );
      } else if (operation === "resize") {
        const { cols, rows } = z
          .object({ cols: z.number(), rows: z.number() })
          .parse(await c.req.json());
        validateTerminalSize(cols, rows);
        await s.process!.resize(cols, rows);
      } else throw new Error("Invalid operation.");
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Terminal session is unavailable." }, 409);
    }
  });
}
