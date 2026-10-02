import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { ComputerConnections, ConnectedSandboxProvider } from "./computer-connections.js";
import { sleepComputerIfIdle, touchRunningComputer } from "./computer-idle.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { HostAwareSandbox } from "./host-aware-sandbox.js";

function harness(statuses: ("active" | "idle")[]) {
  const row = {
    id: "computer",
    homeKey: "home",
    providerRef: "container-ref",
    kind: "desktop",
    connectionId: "saved-container",
    networkEgress: false,
    imageProfile: "developer",
    spaceId: "space",
    userId: "owner",
    state: "running",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    updatedAt: new Date(0),
  };
  const host = {
    execute: vi.fn(async function* () {
      yield { type: "stdout", data: "ardurbot-background-idle\n" } as const;
      yield { type: "exit", code: 1 } as const;
    }),
    exportWorkspace: vi.fn(async function* () {}),
    stop: vi.fn(),
    keepAlive: vi.fn(),
  } as unknown as SandboxProvider;
  const container = {
    execute: vi.fn(async function* () {
      const active = statuses.shift() === "active";
      if (!active) yield { type: "stdout", data: "ardurbot-background-idle\n" } as const;
      yield { type: "exit", code: active ? 0 : 1 } as const;
    }),
    exportWorkspace: vi.fn(async function* () {
      yield { path: "result.txt", content: new TextEncoder().encode("saved container work") };
    }),
    stop: vi.fn(),
    keepAlive: vi.fn(),
  } as unknown as SandboxProvider;
  const connections = new ComputerConnections({} as PrismaClient, { load: vi.fn() }, {});
  const resolve = vi.spyOn(connections, "resolve").mockResolvedValue(container);
  const sandbox = new HostAwareSandbox(
    new ConnectedSandboxProvider(new FakeSandboxProvider(), connections),
    host,
    async () => true,
  );
  const findUnique = vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => select[key])),
  );
  const prisma = {
    computer: {
      findUnique,
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => Object.assign(row, data)),
    },
    run: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    bot: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
  const commit = vi.fn().mockResolvedValue("saved-revision");
  const jobs = { enqueue: vi.fn() } as unknown as JobPublisher;
  return {
    row,
    host,
    container,
    resolve,
    findUnique,
    commit,
    deps: {
      prisma,
      sandbox,
      jobs,
      home: { commit } as unknown as AgentHomeStore,
      events: { append: vi.fn() } as unknown as ThreadEvents,
    },
  };
}

describe("legacy connected computer idle routing", () => {
  it("checkpoints and stops the saved container, never the host", async () => {
    const h = harness(["idle", "idle"]);
    await sleepComputerIfIdle(h.deps, h.row.id);
    expect(h.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: h.row.id },
      select: expect.objectContaining({
        connectionId: true,
        imageProfile: true,
        networkEgress: true,
      }),
    });
    expect(h.container.exportWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "saved-container",
        imageProfile: "developer",
        networkEgress: false,
      }),
      expect.objectContaining({ spaceId: "space" }),
    );
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.container.stop).toHaveBeenCalledOnce();
    expect(h.row.state).toBe("suspended");
    expect(h.host.exportWorkspace).not.toHaveBeenCalled();
    expect(h.host.stop).not.toHaveBeenCalled();
    expect(h.host.execute).not.toHaveBeenCalled();
  });

  it.each([{ statuses: ["active"] }, { statuses: ["idle", "active"] }] as const)(
    "keeps the saved container alive when background work reports $statuses",
    async ({ statuses }) => {
      const h = harness([...statuses]);
      await sleepComputerIfIdle(h.deps, h.row.id);
      expect(h.container.keepAlive).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ connectionId: "saved-container" }),
      );
      expect(h.container.stop).not.toHaveBeenCalled();
      expect(h.host.keepAlive).not.toHaveBeenCalled();
      expect(h.host.exportWorkspace).not.toHaveBeenCalled();
    },
  );

  it("heartbeats through the connection provider with the row's scope and policy", async () => {
    const h = harness([]);
    await touchRunningComputer(h.deps, h.row);
    expect(h.resolve).toHaveBeenCalledWith(
      "saved-container",
      expect.objectContaining({ spaceId: "space", userId: "owner" }),
    );
    expect(h.container.keepAlive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        connectionId: "saved-container",
        imageProfile: "developer",
        networkEgress: false,
      }),
    );
    expect(h.host.keepAlive).not.toHaveBeenCalled();
  });
});
