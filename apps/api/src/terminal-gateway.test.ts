import type { TerminalOutput, TerminalProvider } from "@ardurbot/adapter-kit";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_REPLAY_BYTES,
  TERMINAL_WINDOW_BYTES,
} from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalGrant, TerminalSocket } from "./terminal-gateway.js";
import { TerminalGateway } from "./terminal-gateway.js";

function setup() {
  let live = true,
    now = 1_000,
    sequence = 0;
  const output: TerminalOutput[] = [];
  let wake: (() => void) | undefined;
  const audit: string[] = [],
    order: string[] = [];
  const provider: TerminalProvider = {
    open: vi.fn(async () => ({ id: "terminal-test", generation: "container-test" })),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    close: vi.fn(async () => {
      live = false;
      order.push("descendants-dead");
      wake?.();
    }),
    async *output() {
      while (live) {
        if (!output.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const item = output.shift();
        if (item) yield item;
      }
    },
  };
  const grant = {
    actor: { userId: "user-test", spaceId: "space-test", role: "owner" },
    botId: "bot-test",
    computerId: "computer-test",
    computerGeneration: 2,
    authSessionId: "auth-test",
    computer: {
      id: "container-test",
      providerRef: "container-test",
      botId: "bot-test",
      kind: "docker",
    },
    context: {
      operationId: "terminal.open",
      traceId: "terminal.open",
      spaceId: "space-test",
      userId: "user-test",
      botId: "bot-test",
      signal: new AbortController().signal,
      leaseId: "lease-test",
      fence: 7,
      generation: "container-test",
      expiresAt: 100_000,
      workingRoot: "/home/ardurbot",
    },
  } as TerminalGrant;
  const authorize = vi.fn(async (_grant: TerminalGrant) => {});
  const gateway = new TerminalGateway({
    provider,
    authorize,
    now: () => now,
    audit: async (type) => {
      audit.push(type);
      order.push(type);
    },
  });
  const sent: Array<string | Uint8Array> = [];
  const socket: TerminalSocket = {
    send: vi.fn(async (data) => {
      sent.push(data);
    }),
    close: vi.fn(),
  };
  return {
    gateway,
    provider,
    grant,
    audit,
    order,
    authorize,
    sent,
    socket,
    setNow: (time: number) => {
      now = time;
    },
    push: (bytes: Uint8Array) => {
      output.push({ seq: ++sequence, bytes });
      wake?.();
    },
    output,
  };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("human terminal gateway", () => {
  it("audits opening before input, keeps input out of bot records, and preserves bytes", async () => {
    const f = setup();
    const issued = await f.gateway.request(f.grant, "https://app.example");
    expect(f.audit).toEqual(["requested", "opened"]);
    const attached = await f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket);
    const bytes = Uint8Array.from([0, 255, 128]);
    await attached.receive(encodeTerminalFrame(1, bytes));
    expect(f.provider.write).toHaveBeenCalledWith(issued.sessionId, bytes);
    await expect(attached.receive(encodeTerminalFrame(1, bytes))).rejects.toThrow("Duplicate");
    expect(f.audit).toEqual(["requested", "opened"]);
    await attached.receive('{"type":"close"}');
    expect(f.order).toEqual(["requested", "opened", "descendants-dead", "closed"]);
  });
  it("consumes tickets on use and origin rejection and rejects expired tickets", async () => {
    const f = setup();
    let issued = await f.gateway.request(f.grant, "https://app.example");
    await expect(
      f.gateway.attach(issued.ticket, "https://other.example", 0, f.socket),
    ).rejects.toThrow();
    await expect(
      f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket),
    ).rejects.toThrow();
    issued = await f.gateway.request(f.grant, "https://app.example", issued.sessionId);
    f.setNow(16_001);
    await expect(
      f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket),
    ).rejects.toThrow();
    await f.gateway.stop();
  });
  it("reconnects after the last acknowledgement without replaying input", async () => {
    const f = setup();
    const issued = await f.gateway.request(f.grant, "https://app.example");
    const first = await f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket);
    await first.receive(encodeTerminalFrame(1, new TextEncoder().encode("test")));
    f.push(Uint8Array.of(1));
    f.push(Uint8Array.of(2));
    await tick();
    await first.receive('{"type":"ack","seq":1}');
    first.detach();
    const next = await f.gateway.request(f.grant, "https://app.example", issued.sessionId);
    f.sent.length = 0;
    await f.gateway.attach(next.ticket, "https://app.example", 1, f.socket);
    await tick();
    expect(
      f.sent
        .filter((x) => typeof x !== "string")
        .map((x) => decodeTerminalFrame(x as Uint8Array).seq),
    ).toEqual([2]);
    expect(f.provider.write).toHaveBeenCalledTimes(1);
    expect(f.audit).toEqual(["requested", "opened", "requested", "reconnected"]);
    await f.gateway.stop();
  });
  it.each([
    "userId",
    "spaceId",
    "botId",
    "computerId",
    "authSessionId",
    "fence",
    "generation",
    "computerGeneration",
  ])("binds reconnect to %s", async (field) => {
    const f = setup();
    const issued = await f.gateway.request(f.grant, "https://app.example");
    const changed = { ...f.grant, actor: { ...f.grant.actor }, context: { ...f.grant.context } };
    if (field === "userId" || field === "spaceId") changed.actor[field] = "different";
    else if (field === "fence") changed.context.fence++;
    else if (field === "generation") changed.context.generation = "different";
    else if (field === "computerGeneration") changed.computerGeneration++;
    else Object.assign(changed, { [field]: "different" });
    await expect(
      f.gateway.request(changed, "https://app.example", issued.sessionId),
    ).rejects.toThrow();
    await f.gateway.stop();
  });
  it("fences revoked input and waits for descendant cleanup before returning", async () => {
    const f = setup();
    const issued = await f.gateway.request(f.grant, "https://app.example");
    const attached = await f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket);
    f.authorize.mockRejectedValue(new Error("revoked"));
    await expect(attached.receive(encodeTerminalFrame(1, Uint8Array.of(1)))).rejects.toThrow();
    expect(f.provider.write).not.toHaveBeenCalled();
    expect(f.order.slice(-3)).toEqual(["revoked", "descendants-dead", "closed"]);
  });
  it("expires disconnected sessions within the lease, and refuses stale acknowledgements", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.grant.context.expiresAt = 2_000;
    const issued = await f.gateway.request(f.grant, "https://app.example");
    const attached = await f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket);
    attached.detach();
    f.setNow(2_001);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(f.provider.close).toHaveBeenCalled();
    expect(f.gateway.sessions.size).toBe(0);
  });
  it("propagates output backpressure and caps replay memory", async () => {
    const f = setup();
    const issued = await f.gateway.request(f.grant, "https://app.example");
    const attached = await f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket);
    for (let i = 0; i < 60; i++) f.push(new Uint8Array(64 * 1024));
    await tick();
    const s = f.gateway.sessions.get(issued.sessionId)!;
    expect(s.retained).toBeLessThanOrEqual(TERMINAL_WINDOW_BYTES);
    expect(f.output.length).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      await attached.receive(JSON.stringify({ type: "ack", seq: s.sent }));
      await tick();
      expect(s.retained).toBeLessThanOrEqual(TERMINAL_REPLAY_BYTES);
    }
    await f.gateway.stop();
  });
  it("debounces valid resizes and rejects invalid controls", async () => {
    vi.useFakeTimers();
    const f = setup();
    const issued = await f.gateway.request(f.grant, "https://app.example");
    const attached = await f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket);
    await expect(attached.receive('{"type":"resize","cols":0,"rows":24}')).rejects.toThrow();
    await attached.receive('{"type":"resize","cols":90,"rows":24}');
    await attached.receive('{"type":"resize","cols":100,"rows":30}');
    await vi.advanceTimersByTimeAsync(60);
    expect(f.provider.resize).toHaveBeenCalledTimes(1);
    expect(f.provider.resize).toHaveBeenCalledWith(issued.sessionId, 100, 30);
    await f.gateway.stop();
  });
  it("rejects a second writable attachment and requires a new session on replay gaps", async () => {
    const f = setup();
    const issued = await f.gateway.request(f.grant, "https://app.example");
    await f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket);
    const next = await f.gateway.request(f.grant, "https://app.example", issued.sessionId);
    await expect(
      f.gateway.attach(next.ticket, "https://app.example", 0, f.socket),
    ).rejects.toThrow();
    expect(f.provider.close).not.toHaveBeenCalled();
    await f.gateway.stop();
  });
  it("logout closes only the authenticated actor's terminal and records revocation before closure", async () => {
    const f = setup();
    await f.gateway.request(f.grant, "https://app.example");
    await f.gateway.revokeUser("another-user");
    expect(f.provider.close).not.toHaveBeenCalled();
    await f.gateway.revokeUser(f.grant.actor.userId);
    expect(f.order.slice(-3)).toEqual(["revoked", "descendants-dead", "closed"]);
  });
  it("ends a session when reconnect asks for output older than its acknowledged history", async () => {
    const f = setup();
    const issued = await f.gateway.request(f.grant, "https://app.example");
    const first = await f.gateway.attach(issued.ticket, "https://app.example", 0, f.socket);
    f.push(Uint8Array.of(1));
    await tick();
    await first.receive('{"type":"ack","seq":1}');
    first.detach();
    const ticket = await f.gateway.request(f.grant, "https://app.example", issued.sessionId);
    await expect(
      f.gateway.attach(ticket.ticket, "https://app.example", 0, f.socket),
    ).rejects.toThrow();
    expect(f.provider.close).toHaveBeenCalledWith(issued.sessionId, "replay-gap");
  });
});
