import type {
  AdapterContext,
  ComputerRef,
  TerminalContext,
  TerminalProvider,
} from "@ardurbot/adapter-kit";
import type { HostTerminalAction } from "@ardurbot/contracts/host-bridge";
import type { HostClient } from "@ardurbot/host-runtime/host-client";

/** The host connection generation is pinned once per session, never refreshed for input. */
export function remoteHostTerminal(
  client: Pick<HostClient, "request" | "result" | "health">,
): TerminalProvider {
  const pending = new Set<{
    computer: ComputerRef;
    context: TerminalContext;
    hostGeneration: string;
    cancelled: boolean;
  }>();
  const sessions = new Map<
    string,
    { computer: ComputerRef; context: TerminalContext; hostGeneration: string }
  >();
  const session = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error("Terminal session is unavailable.");
    return s;
  };
  const grant = (s: ReturnType<typeof session>) => ({
    leaseId: s.context.leaseId,
    fence: s.context.fence,
    generation: s.context.generation,
    expiresAt: s.context.expiresAt,
    hostGeneration: s.hostGeneration,
  });
  const operation = (computer: ComputerRef, action: HostTerminalAction) => ({
    op: "computer.terminal" as const,
    homeKey: computer.botId,
    action,
  });
  const call = (s: ReturnType<typeof session>, action: HostTerminalAction) =>
    client.result(operation(s.computer, action), s.context);
  return {
    available: async () => !!(await client.health())?.capabilities?.hostTerminal,
    open: async (computer, options, context) => {
      const hostGeneration = (await client.health())?.capabilities?.hostTerminal?.generation;
      if (!hostGeneration || options.shellProfileId !== "default")
        throw new Error("Terminal is not available on this computer.");
      const s = { computer, context: { ...context }, hostGeneration, cancelled: false };
      pending.add(s);
      try {
        const result = (await call(s, {
          type: "open",
          ...grant(s),
          ...options,
          shellProfileId: "default",
          workingRoot: context.workingRoot,
        })) as { id: string; generation: string };
        if (s.cancelled) throw new Error("Terminal lease is unavailable.");
        sessions.set(result.id, s);
        return result;
      } finally {
        pending.delete(s);
      }
    },
    write: async (id, bytes) => {
      const s = session(id);
      await call(s, {
        type: "write",
        ...grant(s),
        sessionId: id,
        content: Buffer.from(bytes).toString("base64"),
      });
    },
    resize: async (id, cols, rows) => {
      const s = session(id);
      await call(s, { type: "resize", ...grant(s), sessionId: id, cols, rows });
    },
    close: async (id) => {
      const s = sessions.get(id);
      if (!s) return;
      await call(s, { type: "close", ...grant(s), sessionId: id });
      sessions.delete(id);
    },
    async *output(id) {
      const s = session(id);
      for await (const frame of client.request(
        operation(s.computer, { type: "output", ...grant(s), sessionId: id }),
        s.context,
      )) {
        if (frame.channel !== "result") throw new Error("Invalid terminal output.");
        const value = frame.data as { seq: number; content: string };
        yield { seq: value.seq, bytes: Buffer.from(value.content, "base64") };
      }
    },
    revoke: async (computer, leaseId, context: AdapterContext) => {
      const targets = [...sessions].filter(
        ([, s]) =>
          s.computer.id === computer.id &&
          s.context.spaceId === context.spaceId &&
          (leaseId === "*" || s.context.leaseId === leaseId),
      );
      for (const s of pending) {
        if (
          s.computer.id === computer.id &&
          s.context.spaceId === context.spaceId &&
          (leaseId === "*" || s.context.leaseId === leaseId)
        ) {
          s.cancelled = true;
          await call(s, { type: "revoke", ...grant(s) });
        }
      }
      for (const [id, s] of targets) {
        await call(s, { type: "revoke", ...grant(s) });
        sessions.delete(id);
      }
    },
  };
}
