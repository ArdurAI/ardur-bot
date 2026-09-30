import type { Actor } from "@ardurbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { createRepos } from "./repos.js";

const actor = { userId: "owner", spaceId: "space", email: "owner@example.test" } as Actor;
const input = {
  name: "Bot",
  title: "",
  description: "",
  instructions: "",
  color: "slate",
  notifyOnFinish: false,
  computerMode: "dedicated" as const,
};
function fixture(metadata?: unknown) {
  const upsert = vi.fn(async (_args: Prisma.ComputerUpsertArgs) => ({ id: "computer" }));
  const create = vi.fn(async ({ data }) => ({ id: "bot", ...data }));
  const connection = vi.fn(async () => (metadata ? { metadata } : null));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async () => ({ organizationId: "org", space: { deletingAt: null } })),
    },
    connection: { findFirst: connection },
    computer: { upsert },
    bot: {
      aggregate: vi.fn(async () => ({ _max: { position: 0 } })),
      create,
      findFirstOrThrow: vi.fn(async () => ({
        id: "bot",
        name: "Bot",
        computer: { scope: "dedicated" },
        thread: { id: "thread", unread: false },
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
    },
    thread: { create: vi.fn(async () => ({ id: "thread" })) },
    browserProfile: { create: vi.fn() },
    memoryDocument: { create: vi.fn() },
  };
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => ({ computerHost: "this-mac" })) },
    $transaction: vi.fn(async (work) => work(tx)),
  };
  return { repos: createRepos(prisma as unknown as PrismaClient), upsert, create, connection };
}
afterEach(() => vi.unstubAllEnvs());
it("pins new isolated work to dedicated deployment Docker even when the Team computer is the host", async () => {
  vi.stubEnv("SANDBOX_PROVIDER", "docker");
  const f = fixture();
  await f.repos.createBot(actor, { ...input, isolatedComputer: { connectionId: null } });
  expect(f.upsert).toHaveBeenCalledOnce();
  expect(f.upsert.mock.calls[0]?.[0]).toMatchObject({
    create: { scope: "dedicated", kind: "docker", connectionId: null },
    update: {},
  });
});
it.each(["docker", "podman", "kubernetes"])(
  "pins an owned saved %s connection without touching the Team computer",
  async (engine) => {
    vi.stubEnv("SANDBOX_PROVIDER", "desktop");
    const f = fixture({ engine });
    await f.repos.createBot(actor, { ...input, isolatedComputer: { connectionId: "saved" } });
    expect(f.connection).toHaveBeenCalledWith({
      where: { id: "saved", spaceId: "space", connectorId: "computer" },
    });
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: {
        scope: "dedicated",
        kind: engine === "kubernetes" ? "kubernetes" : "remote-docker",
        connectionId: "saved",
      },
      update: {},
    });
  },
);
it.each([undefined, { engine: "ssh" }, { engine: "vm" }])(
  "refuses missing, foreign, remote-account or unknown connections before creating rows (%j)",
  async (metadata) => {
    vi.stubEnv("SANDBOX_PROVIDER", "desktop");
    const f = fixture(metadata);
    await expect(
      f.repos.createBot(actor, { ...input, isolatedComputer: { connectionId: "unavailable" } }),
    ).rejects.toThrow("Set up a container for isolated work.");
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  },
);
it.each(["desktop", "none", "fake", "ssh"])("never silently falls back to %s", async (provider) => {
  vi.stubEnv("SANDBOX_PROVIDER", provider);
  const f = fixture();
  await expect(
    f.repos.createBot(actor, { ...input, isolatedComputer: { connectionId: null } }),
  ).rejects.toThrow("Set up a container for isolated work.");
  expect(f.upsert).not.toHaveBeenCalled();
});
it.each(["hermes", "codex-app-server"])(
  "refuses a host-only runtime %s for new isolated work",
  async (runtimeKind) => {
    vi.stubEnv("SANDBOX_PROVIDER", "docker");
    const f = fixture();
    await expect(
      f.repos.createBot(actor, { ...input, runtimeKind, isolatedComputer: { connectionId: null } }),
    ).rejects.toThrow("Set up a container for isolated work.");
    expect(f.upsert).not.toHaveBeenCalled();
  },
);
