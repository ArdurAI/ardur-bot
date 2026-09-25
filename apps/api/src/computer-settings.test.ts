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
