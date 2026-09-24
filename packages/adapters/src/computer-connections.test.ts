import type { PrismaClient } from "@ardurbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerConnections, ConnectedSandboxProvider } from "./computer-connections.js";
import { fakePodmanSupervisor } from "./docker-test-supervisor.js";
import { createKubernetesApi } from "./kubernetes-client.js";
import { FakeKubernetesApi } from "./kubernetes-test-api.js";
import { NoneSandboxProvider } from "./none-sandbox.js";

vi.mock("./kubernetes-client.js", () => ({ createKubernetesApi: vi.fn() }));
const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function fixture(metadata: Record<string, unknown>) {
  const row = { id: "saved", metadata, secretId: "encrypted", userId: "owner" };
  const prisma = {
    connection: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === "saved" && where.spaceId === "space" ? row : null,
      ),
    },
    secret: {
      findFirst: vi.fn(async () => ({ id: "encrypted", ciphertext: "opaque-ciphertext" })),
    },
  };
  const secrets = { load: vi.fn(() => JSON.stringify({ inline: "credential-placeholder" })) };
  const connections = new ComputerConnections(prisma as unknown as PrismaClient, secrets, {
    supervisorUrl: "http://supervisor.test",
  });
  return {
    prisma,
    secrets,
    connections,
    provider: new ConnectedSandboxProvider(new NoneSandboxProvider(), connections),
  };
}

describe("saved computer connections", () => {
  it("routes a saved Podman computer even when the deployment default is none", async () => {
    vi.stubGlobal("fetch", fakePodmanSupervisor(context));
    const { provider, secrets } = fixture({ engine: "podman", socket: "/tmp/podman.sock" });
    const computer = await provider.provision(
      { botId: "bot", homePath: "/unused", connectionId: "saved", imageProfile: "developer" },
      context,
    );
    expect(computer).toMatchObject({
      kind: "docker",
      connectionId: "saved",
      imageProfile: "developer",
    });
    await provider.writeFile(
      computer,
      { path: "saved.txt", content: new TextEncoder().encode("retained") },
      context,
    );
    expect(new TextDecoder().decode(await provider.readFile(computer, "saved.txt", context))).toBe(
      "retained",
    );
    await provider.destroy(computer, context);
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("rejects a connection from another space before accessing its credentials", async () => {
    const { connections, secrets, prisma } = fixture({
      engine: "kubernetes",
      context: "kind-local",
    });
    await expect(connections.resolve("saved", { ...context, spaceId: "other" })).rejects.toThrow(
      "unavailable",
    );
    expect(secrets.load).not.toHaveBeenCalled();
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
  });

  it("decrypts kubeconfig only for the API client and never puts it in the pod", async () => {
    const api = new FakeKubernetesApi();
    vi.mocked(createKubernetesApi).mockResolvedValue(api);
    const { provider, prisma, secrets } = fixture({ engine: "kubernetes", context: "kind-local" });
    try {
      const computer = await provider.provision(
        { botId: "bot", homePath: "/unused", connectionId: "saved" },
        context,
      );
      expect(prisma.secret.findFirst).toHaveBeenCalledWith({
        where: { id: "encrypted", spaceId: "space", userId: "owner" },
      });
      expect(secrets.load).toHaveBeenCalledWith("opaque-ciphertext", "encrypted");
      expect(createKubernetesApi).toHaveBeenCalledWith(
        { inline: "credential-placeholder" },
        "ardurbot",
        "kind-local",
      );
      expect(JSON.stringify([...api.objects.values()])).not.toContain("credential-placeholder");
      await provider.destroy(computer, context);
    } finally {
      api.dispose();
    }
  });
});
