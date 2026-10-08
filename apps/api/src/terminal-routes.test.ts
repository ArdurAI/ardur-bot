import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SandboxProvider, TerminalProvider } from "@ardurbot/adapter-kit";
import { ComputerConnections, ConnectedSandboxProvider } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_ENDED,
  TERMINAL_FRAME_BYTES,
  TERMINAL_HEADER_BYTES,
} from "@ardurbot/contracts";
import type { HostFrame, HostOperation } from "@ardurbot/contracts/host-bridge";
import { decodeHostFrame, encodeHostFrame } from "@ardurbot/contracts/host-bridge";
import type * as Db from "@ardurbot/db";
import type { PrismaClient } from "@ardurbot/db";
import { FleetService } from "@ardurbot/host-runtime/fleet/service";
import { FleetTerminal } from "@ardurbot/host-runtime/fleet/terminal";
import { RuntimeQueue } from "@ardurbot/host-runtime/runtimes/native-process";
import { describe, expect, it, vi } from "vitest";
import { createTerminalRoutes } from "./terminal-routes.js";

vi.mock("@ardurbot/db", async (original) => ({
  ...(await original<typeof Db>()),
  requireMembership: vi.fn(async (_db, user: string, space: string) => {
    if (user !== "user" || space !== "space") throw new Error("denied");
    return {};
  }),
}));
function fixture(defaultTerminal = true) {
  const actor = { userId: "user", spaceId: "space", role: "owner" } as Actor;
  const computer = {
    id: "computer",
    homeKey: "home",
    userId: "user",
    spaceId: "space",
    scope: "team",
    scopeKey: "team:space",
    providerRef: "container",
    screenGeneration: 2,
    kind: "docker",
    connectionId: null as string | null,
    state: "running",
    maintenanceId: null,
    controlHolder: "user",
    controlBotId: "bot",
    controlLeaseId: "lease",
    controlFence: 1,
    controlLeaseExpiresAt: new Date(Date.now() + 60_000),
  };
  const provider: TerminalProvider = {
    open: vi.fn(async () => ({ id: "session", generation: "container" })),
    close: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    async *output() {
      await new Promise(() => {});
    },
  };
  const computerAdmission = {
    findFirst: async () => null,
    create: async () => ({}),
    deleteMany: async () => ({ count: 1 }),
  };
  const db = {
    computerAdmission,
    bot: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "bot" &&
        where.userId === "user" &&
        where.spaceId === "space" &&
        where.computerId === "computer"
          ? { computer }
          : null,
      ),
    },
    computer: {
      findUniqueOrThrow: vi.fn(async () => computer),
      update: vi.fn(async () => {
        computer.controlFence++;
        return computer;
      }),
    },
    session: { findFirst: vi.fn(async () => ({ id: "auth" })) },
    terminalAudit: { create: vi.fn(async () => ({})) },
    $transaction: async (work: (tx: unknown) => unknown) =>
      work({
        computerAdmission,
        $queryRaw: async () => [{ acquired: true }],
        computer: { findUniqueOrThrow: async () => computer },
      }),
  };
  const resolveCommandCwd = vi.fn(async (_computer, cwd: string | undefined) => {
    const root = computer.kind === "ssh" ? "/remote/computers/home" : "/home/ardurbot";
    return cwd ? `${root}/${cwd}` : root;
  });
  const routes = createTerminalRoutes({
    prisma: db as unknown as PrismaClient,
    sandbox: {
      terminal: provider,
      resolveCommandCwd,
      describe: () => ({ capabilities: { interactiveTerminal: defaultTerminal } }),
    } as SandboxProvider,
    trustedOrigin: (origin) => origin === "https://app.example",
  });
  return { actor, computer, provider, db, routes, resolveCommandCwd };
}
describe("terminal authorization", () => {
  it.each(["ssh", "remote-docker"])(
    "serializes %s terminal requests through the host bridge",
    async (kind) => {
      vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
      const f = fixture(false);
      f.computer.kind = kind;
      f.computer.connectionId = "saved-connection";
      const root = kind === "ssh" ? "/remote/computers/home" : "/home/ardurbot";
      const requests: HostOperation[] = [];
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: 0,
        signalCode: null,
      });
      const cleanup = vi.fn(async () => {});
      const fleet = new FleetTerminal(
        async () => ({ child: child as unknown as ChildProcessWithoutNullStreams, cleanup }),
        async () => root,
      );
      const write = vi.spyOn(child.stdin, "write");
      const service = new FleetService("/unused", "fixture-encryption-material");
      vi.spyOn(service, "provider").mockReturnValue({
        describe: () => ({ id: kind === "ssh" ? "ssh" : "remote-docker" }),
        terminal: fleet,
        resolveCommandCwd: async (_computer, cwd) => `${root}/${cwd}`,
      } as SandboxProvider);
      const connections = new ComputerConnections(
        {
          connection: {
            findFirst: async () => ({
              metadata:
                kind === "ssh"
                  ? { engine: "ssh", ssh: { host: "computer.invalid", user: "runner" } }
                  : { engine: "docker", endpoint: "ssh://runner@computer.invalid" },
            }),
          },
        } as unknown as PrismaClient,
        { load: () => "" },
        {
          hostClient: {
            health: async () => null,
            result: async () => undefined,
            async *request(operation, context) {
              const request = decodeHostFrame(
                encodeHostFrame({
                  v: 1,
                  type: "request",
                  id: "request",
                  scope: {
                    userId: "user",
                    spaceId: "space",
                    botId: "bot",
                    runId: "terminal",
                  },
                  operation,
                }),
              );
              if (request.type !== "request") throw new Error("Unexpected frame");
              operation = request.operation;
              requests.push(operation);
              if (operation.op !== "computer.remote.call") throw new Error("Unexpected operation");
              const output = new RuntimeQueue<HostFrame>();
              let sequence = 0;
              const call = service.call(operation, context, async (channel, data) => {
                output.push(
                  decodeHostFrame(
                    encodeHostFrame({
                      v: 1,
                      type: "stream",
                      id: "request",
                      seq: sequence++,
                      channel,
                      data,
                    }),
                  ),
                );
              });
              void call.then(
                () => output.end(),
                (error) => output.end(error),
              );
              for await (const frame of output) {
                if (frame.type !== "stream") throw new Error("Unexpected frame");
                yield frame;
              }
            },
          },
        },
      );
      const routes = createTerminalRoutes({
        prisma: f.db as unknown as PrismaClient,
        sandbox: new ConnectedSandboxProvider(
          { describe: () => ({ capabilities: { interactiveTerminal: false } }) } as SandboxProvider,
          connections,
        ),
        trustedOrigin: (origin) => origin === "https://app.example",
      });
      const input = { botId: "bot", computerId: "computer" };
      let sessionId: string | undefined;
      try {
        const ticket = await routes.ticket(f.actor, input, "auth", "https://app.example");
        sessionId = ticket.sessionId;
        expect(requests).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              op: "computer.remote.call",
              action: expect.objectContaining({
                type: "terminal.open",
                workingRoot: `${root}/bots/bot`,
              }),
            }),
          ]),
        );
        const sent: Array<string | Uint8Array> = [];
        const socket = {
          send: async (data: string | Uint8Array) => {
            sent.push(data);
          },
          close: vi.fn(),
        };
        const attached = await routes.gateway!.attach(
          ticket.ticket,
          "https://app.example",
          0,
          socket,
        );
        const bytes = [Buffer.from("你好 🧪 $ "), Buffer.from([0, 128, 255, 27])];
        child.stdout.write(
          bytes.map((value) => `${JSON.stringify({ bytes: value.toString("base64") })}\n`).join(""),
        );
        const frames = () =>
          sent
            .filter((frame): frame is Uint8Array => typeof frame !== "string")
            .map(decodeTerminalFrame);
        await vi.waitFor(() =>
          expect(frames()).toEqual(
            bytes.map((value, index) => ({ seq: index + 1, bytes: Uint8Array.from(value) })),
          ),
        );
        for (const [index, value] of [
          ...bytes,
          Buffer.alloc(TERMINAL_FRAME_BYTES, 255),
        ].entries()) {
          await attached.receive(encodeTerminalFrame(index + 1, value));
          expect(
            Buffer.from(JSON.parse(String(write.mock.calls.at(-1)![0])).bytes, "base64"),
          ).toEqual(value);
        }
        const oversized = new Uint8Array(TERMINAL_HEADER_BYTES + TERMINAL_FRAME_BYTES + 1);
        oversized[0] = 1;
        new DataView(oversized.buffer).setUint32(1, 4);
        new DataView(oversized.buffer).setUint32(5, TERMINAL_FRAME_BYTES + 1);
        await expect(attached.receive(oversized)).rejects.toThrow("Invalid terminal frame.");
        expect(write).toHaveBeenCalledTimes(3);
        expect(
          requests.filter(
            (operation) =>
              operation.op === "computer.remote.call" && operation.action.type === "terminal.write",
          ),
        ).toHaveLength(3);
        expect(routes.gateway!.sessions.has(ticket.sessionId)).toBe(true);
        expect(socket.close).not.toHaveBeenCalled();
      } finally {
        if (sessionId) await routes.close(f.actor, { ...input, sessionId });
        await fleet.closeAll();
        await service.close();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );
  it.each(["ssh", "remote-docker"])(
    "opens and authorizes %s terminals at the resolved root",
    async (kind) => {
      for (const workspace of [undefined, "computer"] as const) {
        const f = fixture(false);
        f.computer.kind = kind;
        f.computer.connectionId = "saved-connection";
        const input = { botId: "bot", computerId: "computer", workspace };
        expect(await f.routes.available(f.actor, input)).toEqual({ available: true });
        const ticket = await f.routes.ticket(f.actor, input, "auth", "https://app.example");
        try {
          const root = kind === "ssh" ? "/remote/computers/home" : "/home/ardurbot";
          expect(f.provider.open).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ workingRoot: workspace ? root : `${root}/bots/bot` }),
          );
          await f.routes.gateway!.attach(ticket.ticket, "https://app.example", 0, {
            send: async () => {},
            close: () => {},
          });
          expect(f.provider.close).not.toHaveBeenCalled();
        } finally {
          await f.routes.close(f.actor, { ...input, sessionId: ticket.sessionId });
        }
      }
    },
  );
  it("uses a saved Docker connection's capability when the default has no terminal", async () => {
    const f = fixture(false);
    const input = { botId: "bot", computerId: "computer" };
    expect(await f.routes.available(f.actor, input)).toEqual({ available: false });
    f.computer.connectionId = "saved-docker";
    expect(await f.routes.available(f.actor, input)).toEqual({ available: true });
    f.computer.kind = "kubernetes";
    expect(await f.routes.available(f.actor, input)).toEqual({ available: false });
    await expect(f.routes.ticket(f.actor, input, "auth", "https://app.example")).rejects.toThrow();
    expect(f.provider.open).not.toHaveBeenCalled();
  });
  it.each(["user", "space", "bot", "computer", "team-key", "dedicated-user", "origin", "session"])(
    "denies across %s boundaries before opening a PTY",
    async (boundary) => {
      const f = fixture();
      const input = { botId: "bot", computerId: "computer" };
      let origin = "https://app.example",
        auth: string | undefined = "auth";
      if (boundary === "user") f.actor.userId = "other";
      if (boundary === "space") f.actor.spaceId = "other";
      if (boundary === "bot") input.botId = "other";
      if (boundary === "computer") input.computerId = "other";
      if (boundary === "team-key") f.computer.scopeKey = "team:other";
      if (boundary === "dedicated-user") {
        f.computer.scope = "dedicated";
        f.computer.userId = "other";
      }
      if (boundary === "origin") origin = "https://other.example";
      if (boundary === "session") auth = undefined;
      await expect(f.routes.ticket(f.actor, input, auth, origin)).rejects.toThrow();
      expect(f.provider.open).not.toHaveBeenCalled();
      expect(f.db.terminalAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: "denied" }) }),
      );
    },
  );
  it("revalidates the session, computer generation and control fence on input", async () => {
    const f = fixture();
    const issued = await f.routes.ticket(
      f.actor,
      { botId: "bot", computerId: "computer" },
      "auth",
      "https://app.example",
    );
    f.computer.screenGeneration++;
    await expect(
      f.routes.gateway!.attach(issued.ticket, "https://app.example", 0, {
        send: async () => {},
        close: () => {},
      }),
    ).rejects.toThrow();
    expect(f.provider.close).toHaveBeenCalled();
    expect(f.provider.write).not.toHaveBeenCalled();
  });
});

it("preserves one production-route fence across four sessions and refuses a fifth", async () => {
  const f = fixture();
  const input = { botId: "bot", computerId: "computer" };
  let opened = 0;
  vi.mocked(f.provider.open).mockImplementation(async () => ({
    id: `session-${++opened}`,
    generation: "container",
  }));
  try {
    const sessions = [];
    for (const _ of [1, 2, 3, 4])
      sessions.push(await f.routes.ticket(f.actor, input, "auth", "https://app.example"));
    expect(f.db.computer.update).toHaveBeenCalledOnce();
    expect(f.computer.controlFence).toBe(2);
    await expect(
      f.routes.ticket(f.actor, input, "auth", "https://app.example"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Four terminals are already open.",
    });
    expect(f.provider.open).toHaveBeenCalledTimes(4);
    await f.routes.close(f.actor, { ...input, sessionId: sessions[1]!.sessionId });
    expect(f.routes.gateway!.sessions.size).toBe(3);
    await expect(
      f.routes.ticket(f.actor, input, "other-auth", "https://app.example"),
    ).rejects.toThrow();
    expect(f.db.computer.update).toHaveBeenCalledOnce();
    expect(f.routes.gateway!.sessions.has(sessions[0]!.sessionId)).toBe(true);
    await f.routes.ticket(f.actor, input, "auth", "https://app.example");
    expect(f.provider.open).toHaveBeenCalledTimes(5);
    expect(f.db.computer.update).toHaveBeenCalledOnce();
  } finally {
    await f.routes.gateway!.stop();
  }
});

it("reports an expired terminal session without blaming the caller's valid control lease", async () => {
  const f = fixture();
  await expect(
    f.routes.ticket(
      f.actor,
      { botId: "bot", computerId: "computer", sessionId: "expired" },
      "auth",
      "https://app.example",
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", message: TERMINAL_ENDED });
  expect(f.provider.open).not.toHaveBeenCalled();
});

it("opens an IDE terminal at the computer root while chat retains the bot working directory", async () => {
  const ide = fixture();
  await ide.routes.ticket(
    ide.actor,
    { botId: "bot", computerId: "computer", workspace: "computer" },
    "auth",
    "https://app.example",
  );
  expect(ide.provider.open).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workingRoot: "/home/ardurbot" }),
  );
  const chat = fixture();
  await chat.routes.ticket(
    chat.actor,
    { botId: "bot", computerId: "computer" },
    "auth",
    "https://app.example",
  );
  expect(chat.provider.open).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ workingRoot: "/home/ardurbot/bots/bot" }),
  );
});
