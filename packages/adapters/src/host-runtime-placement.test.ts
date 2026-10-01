import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import type { ComputerConnections } from "./computer-connections.js";
import { ConnectedSandboxProvider } from "./computer-connections.js";
import { replaceComputer } from "./computer-lifecycle.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "move",
  traceId: "move",
  spaceId: "space",
  userId: "owner",
  botId: "bot",
  signal: new AbortController().signal,
};
it.each(["team", "dedicated"])(
  "an explicit host move transfers the %s workspace and clears the container connection",
  async (scope) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "placement-"));
    const source = new FakeSandboxProvider();
    const host = new FakeSandboxProvider();
    const hostDescription = host.describe();
    vi.spyOn(host, "describe").mockReturnValue({
      ...hostDescription,
      id: "desktop",
      kind: "desktop",
    });
    const hostProvision = host.provision.bind(host);
    vi.spyOn(host, "provision").mockImplementation(async (request, ctx) => ({
      ...(await hostProvision(request, ctx)),
      kind: "desktop",
    }));
    const original = await source.provision({ botId: "home", homePath: dataDir }, context);
    await source.writeFile(
      original,
      { path: "work.txt", content: new TextEncoder().encode("saved work"), executable: false },
      context,
    );
    const row = {
      id: "computer",
      homeKey: "home",
      spaceId: "space",
      userId: "owner",
      scope,
      kind: "desktop",
      connectionId: "container",
      state: "running",
      providerRef: original.providerRef,
      controlHolder: "none",
      controlLeaseId: null,
      controlLeaseExpiresAt: null,
      controlBotId: null,
      controlRunId: null,
      updatedAt: new Date(0),
      homeRevision: null as string | null,
    };
    const updateMany = vi.fn(async ({ data }: { data: Partial<typeof row> }) => {
      Object.assign(row, data);
      return { count: 1 };
    });
    const prisma = {
      computer: { findUniqueOrThrow: vi.fn(async () => ({ ...row })), updateMany },
      run: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const connections = { resolve: vi.fn(async () => source) } as unknown as ComputerConnections;
    const sandbox = new ConnectedSandboxProvider(source, connections, { desktop: () => host });
    const destroy = vi.spyOn(source, "destroy");
    const deps = {
      prisma,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      dataDir,
      jobs: { enqueue: vi.fn(async () => {}) } as unknown as JobPublisher,
      events: {} as ThreadEvents,
    };
    try {
      expect(row.connectionId).toBe("container");
      const result = await replaceComputer(deps, row.id, "update", context, "none", undefined, {
        destination: "host",
      });
      expect(result.kind).toBe("desktop");
      expect(row).toMatchObject({ kind: "desktop", connectionId: null, state: "running", scope });
      expect(destroy).toHaveBeenCalledOnce();
      expect(new TextDecoder().decode(await host.readFile(result, "work.txt", context))).toBe(
        "saved work",
      );
      expect(host.provision).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: null, providerKind: "desktop" }),
        expect.anything(),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
it("an unavailable host is refused before destroying the current computer", async () => {
  const sandbox = new FakeSandboxProvider();
  const destroy = vi.spyOn(sandbox, "destroy");
  const updateMany = vi.fn();
  const prisma = {
    computer: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "computer",
        scope: "dedicated",
        kind: "fake",
        connectionId: null,
        state: "stopped",
        controlHolder: "none",
        controlLeaseId: null,
        updatedAt: new Date(0),
      })),
      updateMany,
    },
  } as unknown as PrismaClient;
  await expect(
    replaceComputer(
      {
        prisma,
        sandbox,
        home: {} as LocalAgentHomeStore,
        jobs: {} as JobPublisher,
        events: {} as ThreadEvents,
      },
      "computer",
      "update",
      context,
      "none",
      undefined,
      { destination: "host" },
    ),
  ).rejects.toThrow("not configured");
  expect(updateMany).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
});
