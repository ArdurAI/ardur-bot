import { DockerSandboxProvider, EncryptedSecretStore } from "@ardurbot/adapters";
import {
  ComputerConnectionSettingsSchema,
  ComputerEngineUnavailableError,
} from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import {
  computerEngineInfo,
  listComputerConnections,
  saveComputerConnection,
  validateComputerConfiguration,
} from "./computer-settings.js";

const context = {
  operationId: "settings",
  traceId: "settings",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
describe("computer connection settings", () => {
  it("returns the saved connection state without an owner-only engine probe", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "engine",
        displayName: "Local engine",
        status: "error",
        metadata: { engine: "docker" },
      },
    ]);
    const prisma = { connection: { findMany } } as unknown as PrismaClient;
    expect(await listComputerConnections(prisma, "space")).toMatchObject([
      { id: "engine", name: "Local engine", status: "error" },
    ]);
    expect(findMany).toHaveBeenCalledWith({ where: { spaceId: "space", connectorId: "computer" } });
  });
  it("validates confirmation and workspace ownership before any mutation", async () => {
    const findFirst = vi.fn(async () => null);
    const prisma = { connection: { findFirst } } as unknown as PrismaClient;
    await expect(
      validateComputerConfiguration(prisma, "space", {
        botId: "bot",
        imageProfile: "developer",
        connectionId: "foreign",
        confirmed: false,
      }),
    ).rejects.toThrow("Continue?");
    expect(findFirst).not.toHaveBeenCalled();
    await expect(
      validateComputerConfiguration(prisma, "space", {
        botId: "bot",
        imageProfile: "developer",
        connectionId: "foreign",
        confirmed: true,
      }),
    ).rejects.toThrow("available computer connection");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "foreign", spaceId: "space", connectorId: "computer" },
    });
  });
  it("rejects an empty connection for a connected computer when This Mac is the deployment default", async () => {
    const update = vi.fn();
    const prisma = {
      bot: {
        findFirst: vi.fn(async () => ({ computer: { connectionId: "office" } })),
      },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({ computerHost: "this-mac" })),
      },
      computer: { update },
      computerUpdate: { create: vi.fn() },
      connection: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    const move = {
      botId: "bot",
      imageProfile: "base" as const,
      connectionId: null,
      confirmed: true as const,
    };
    for (const provider of ["docker", "desktop"])
      await expect(validateComputerConfiguration(prisma, "space", move, provider)).rejects.toThrow(
        "Moving a computer onto the machine running Ardur Bot is not available yet. Choose a saved connection or keep the current engine.",
      );
    expect(update).not.toHaveBeenCalled();
    expect(prisma.computerUpdate.create).not.toHaveBeenCalled();
    expect(prisma.connection.findFirst).not.toHaveBeenCalled();
  });
  it("accepts an empty connection when Docker is the deployment default", async () => {
    const prisma = {
      bot: { findFirst: async () => ({ computer: { connectionId: "office" } }) },
      deploymentSettings: { findUnique: async () => ({ computerHost: "docker" }) },
      connection: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await expect(
      validateComputerConfiguration(prisma, "space", {
        botId: "bot",
        imageProfile: "base",
        connectionId: null,
        confirmed: true,
      }),
    ).resolves.toMatchObject({ connectionId: null, confirmed: true });
    expect(prisma.connection.findFirst).not.toHaveBeenCalled();
  });
  it("stores a generic engine socket without a credential or provider-specific variable", async () => {
    const create = vi.fn(async ({ data }) => ({ id: "connection", ...data }));
    const tx = { connection: { create }, secret: { create: vi.fn() } };
    const prisma = {
      $transaction: async (work: (db: typeof tx) => unknown) => work(tx),
    } as unknown as PrismaClient;
    await saveComputerConnection(
      { prisma, secrets: new EncryptedSecretStore("test-only-key") },
      {
        name: "Local",
        settings: ComputerConnectionSettingsSchema.parse({
          engine: "podman",
          socket: "unix:///tmp/podman.sock",
        }),
      },
      context,
    );
    expect(create.mock.calls[0]![0].data.metadata).toMatchObject({
      engine: "podman",
      socket: "unix:///tmp/podman.sock",
    });
    expect(tx.secret.create).not.toHaveBeenCalled();
  });
});

it("returns the actionable engine reason as a client-visible service failure", async () => {
  const failure = new ComputerEngineUnavailableError({
    error: "engine-unavailable",
    engine: "docker",
    socket: "/fixture/docker.sock",
  });
  const probe = vi.spyOn(DockerSandboxProvider.prototype, "engineInfo").mockRejectedValue(failure);
  try {
    await expect(
      computerEngineInfo({ prisma: {} as PrismaClient, env: {} }, null, context),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: failure.message });
  } finally {
    probe.mockRestore();
  }
});
