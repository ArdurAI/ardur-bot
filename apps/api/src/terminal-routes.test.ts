import type { SandboxProvider, TerminalProvider } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import { TERMINAL_ENDED } from "@ardurbot/contracts";
import type * as Db from "@ardurbot/db";
import type { PrismaClient } from "@ardurbot/db";
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
  const routes = createTerminalRoutes({
    prisma: db as unknown as PrismaClient,
    sandbox: {
      terminal: provider,
      describe: () => ({ capabilities: { interactiveTerminal: defaultTerminal } }),
    } as SandboxProvider,
    trustedOrigin: (origin) => origin === "https://app.example",
  });
  return { actor, computer, provider, db, routes };
}
describe("terminal authorization", () => {
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

it("returns the actionable admission reason without opening a second terminal", async () => {
  const f = fixture();
  const input = { botId: "bot", computerId: "computer" };
  const first = await f.routes.ticket(f.actor, input, "auth", "https://app.example");
  try {
    await expect(
      f.routes.ticket(f.actor, input, "auth", "https://app.example"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A terminal is already open. Close it before opening another.",
    });
    expect(f.provider.open).toHaveBeenCalledOnce();
  } finally {
    await f.routes.close(f.actor, { ...input, sessionId: first.sessionId });
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
