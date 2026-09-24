import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryProvider, SpaceMemoryProviderResolver } from "./memory-provider-factory.js";

function resolverFor(
  plaintext: string,
  options: { mode?: "cloud" | "local"; ownerUserId?: string | null; baseUrl?: string } = {},
) {
  const prisma = {
    spaceMemoryConfig: {
      findUnique: vi.fn(async () => ({
        userId: "config-author",
        provider: "supermemory",
        settings: {
          mode: options.mode ?? "cloud",
          baseUrl: options.baseUrl ?? "https://api.supermemory.ai",
        },
        defaultMemoryScope: "shared",
        secret: { ciphertext: "encrypted" },
      })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: options.ownerUserId ?? null })),
    },
  };
  const secrets = { load: vi.fn(() => plaintext) };
  return {
    resolver: new SpaceMemoryProviderResolver(prisma as never, secrets as never),
    secrets,
    prisma,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("semantic provider registration", () => {
  it.each(["mem0", "mem0-oss", "graphiti"])("constructs %s without network IO", (provider) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      createMemoryProvider(
        provider,
        { baseUrl: "http://127.0.0.1:8000" },
        provider === "mem0" ? { apiKey: "fixture-placeholder" } : {},
      ).describe().id,
    ).toBe(provider);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["mem0-oss", "graphiti"])(
    "resolves encrypted empty credentials for %s",
    async (provider) => {
      const f = resolverFor("{}", { ownerUserId: "config-author" });
      f.prisma.spaceMemoryConfig.findUnique.mockResolvedValue({
        userId: "config-author",
        provider,
        settings: { baseUrl: "http://127.0.0.1:8000", endpointTrust: "private" },
        defaultMemoryScope: "shared",
        secret: { ciphertext: "encrypted" },
      } as never);
      const resolved = await f.resolver.resolve("space");
      expect(resolved?.provider.constructor.name).toBe(
        provider === "graphiti" ? "GraphitiMemoryProvider" : "Mem0MemoryProvider",
      );
    },
  );
});

describe("SpaceMemoryProviderResolver", () => {
  it.each([null, "another-user"])(
    "fails closed for saved local configurations without current deployment-owner authorization: %s",
    async (ownerUserId) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { resolver, secrets } = resolverFor("sm_fake_key", {
        mode: "local",
        baseUrl: "http://127.0.0.1:8123/internal-action#",
        ownerUserId,
      });

      const configured = await resolver.resolve("workspace-1");
      expect(configured?.provider.describe().id).toBe("supermemory");
      await expect(
        configured?.provider.recall(
          { query: "fact", botId: "bot", scope: "isolated", limit: 1 },
          {} as never,
        ),
      ).resolves.toMatchObject({ ok: false });
      expect(secrets.load).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retains deployment-owner-configured local memory for Space members", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://localhost:6767/memory/",
      ownerUserId: "config-author",
    });
    const configured = await resolver.resolve("workspace-1");
    await configured!.provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "workspace-1",
        userId: "space-member",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:6767/memory/v4/search");
  });

  it("rejects ambiguous persisted URLs even when the deployment owner configured them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://127.0.0.1:8123/internal-action#",
      ownerUserId: "config-author",
    });
    const configured = await resolver.resolve("workspace-1");
    expect(configured?.provider.describe().id).toBe("supermemory");
    expect(
      await configured!.provider.recall(
        { query: "fact", scope: "isolated", botId: "bot-1", limit: 1 },
        {
          spaceId: "workspace-1",
          userId: "config-author",
          operationId: "fixture",
          traceId: "fixture",
          signal: new AbortController().signal,
        },
      ),
    ).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads generic JSON credential payloads", async () => {
    const { resolver, prisma } = resolverFor(JSON.stringify({ apiKey: "sm_json_key" }));

    const configured = await resolver.resolve("workspace-1");

    expect(configured?.provider.describe().id).toBe("supermemory");
    expect(configured?.defaultScope).toBe("shared");
    expect(prisma.deploymentSettings.findUnique).not.toHaveBeenCalled();
  });

  it("keeps legacy raw Supermemory credentials usable after the schema migration", async () => {
    const { resolver } = resolverFor("sm_legacy_key");

    const configured = await resolver.resolve("workspace-1");

    expect(configured?.provider.describe().id).toBe("supermemory");
  });

  it("revalidates persisted provider endpoints before using decrypted credentials", async () => {
    expect(() =>
      createMemoryProvider(
        "supermemory",
        { mode: "local", baseUrl: "https://memory.example.com" },
        { apiKey: "sm_test_key" },
      ),
    ).toThrow(/loopback/);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createMemoryProvider(
      "supermemory",
      { mode: "cloud", baseUrl: "https://memory.example.com" },
      { apiKey: "sm_test_key" },
    );

    await provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "workspace-1",
        userId: "user-1",
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.supermemory.ai/v4/search");
    vi.unstubAllGlobals();
  });
});
