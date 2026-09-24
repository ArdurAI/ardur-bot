import { readFileSync } from "node:fs";
import type { HostFrame, HostRequest } from "@ardurbot/contracts/host-bridge";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { HostBridge, hostTokenHash } from "./host-bridge.js";

function fixture() {
  let registration: {
    userId: string;
    tokenHash: string;
    generation: string;
    hostRoots: string[];
  } | null = null;
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    hostRegistration: {
      create: vi.fn(async ({ data }) => {
        if (registration) throw new Error("Already paired");
        registration = { ...data, hostRoots: [] };
        return registration;
      }),
      findUnique: vi.fn(async () => registration),
      deleteMany: vi.fn(async ({ where }) => {
        if (registration?.userId === where.userId) registration = null;
        return { count: 1 };
      }),
    },
    run: { findFirst: vi.fn(async () => null) },
  };
  return {
    prisma,
    bridge: new HostBridge(prisma as unknown as PrismaClient, "fixture-encryption-material"),
  };
}
describe("host pairing and grants", () => {
  it("mints once for the owner, stores only a digest, and revokes", async () => {
    const { bridge, prisma } = fixture();
    await expect(bridge.pair("member")).rejects.toThrow("owner");
    const { token } = await bridge.pair("owner");
    expect(token).toHaveLength(43);
    expect(prisma.hostRegistration.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tokenHash: hostTokenHash(token), userId: "owner" }),
    });
    expect(JSON.stringify(prisma.hostRegistration.create.mock.calls)).not.toContain(token);
    await expect(bridge.pair("owner")).rejects.toThrow("Already paired");
    expect(await bridge.status("member")).toEqual({
      roots: [],
      configured: false,
      connected: false,
      health: null,
    });
    expect(JSON.stringify(await bridge.status("owner"))).not.toContain(token);
    await bridge.disconnect("owner");
    expect((await bridge.status("owner")).configured).toBe(false);
  });
  it("keeps host tokens out of Compose and process logs", () => {
    const compose = readFileSync(
      new URL("../../../infra/compose/docker-compose.images.yml", import.meta.url),
      "utf8",
    );
    expect(compose).toContain("ARDURBOT_HOST_BRIDGE: api");
    expect(compose).not.toMatch(/HOST_(?:SERVICE_)?TOKEN|HOST_BRIDGE_TOKEN/);
    const host = readFileSync(new URL("../../host-service/src/index.ts", import.meta.url), "utf8");
    expect(host).not.toMatch(/console\.|logger\.|process\.stderr\.write/);
  });
  it("binds an active native turn to its owner, space, home, generation and saved pin", async () => {
    const { bridge, prisma } = fixture();
    await bridge.pair("owner");
    const registration = await prisma.hostRegistration.findUnique();
    const pin = {
      runtimeKind: "claude-code",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      effort: "low",
      revision: 1,
      credentialId: "credential",
    } as const;
    const request: HostRequest = {
      v: 1,
      type: "request",
      id: "request",
      scope: { userId: "owner", spaceId: "space", botId: "bot", runId: "run" },
      operation: {
        op: "runtime.turn",
        homeKey: "computer",
        request: {
          botId: "bot",
          runId: "run",
          threadId: "thread",
          prompt: "test",
          instructions: "",
          history: [],
          tools: "none",
          model: { runtimePin: pin, provider: "anthropic", id: pin.modelId, thinkingLevel: "low" },
        },
      },
    };
    prisma.run.findFirst.mockResolvedValue({
      id: "run",
      botId: "bot",
      threadId: "thread",
      runtimePin: pin,
      bot: { spaceId: "space", computer: { kind: "desktop", homeKey: "computer" } },
    } as never);
    const sent: HostFrame[] = [];
    const host = {
      send: vi.fn(async (frame: HostFrame) => {
        sent.push(frame);
      }),
      close: vi.fn(),
    };
    const worker = { send: vi.fn(async (_frame: HostFrame) => undefined), close: vi.fn() };
    bridge.hub.attach(host, "owner", registration!.generation);
    await bridge.hub.request(request, worker);
    expect(sent).toEqual([request]);
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "run",
          botId: "bot",
          spaceId: "space",
          userId: "owner",
          status: "running",
          cancelRequestedAt: null,
        },
      }),
    );
    await bridge.hub.fromHost(host, { v: 1, type: "end", id: request.id });
    if (request.operation.op !== "runtime.turn") throw new Error("Expected native turn");
    for (const operation of [
      { ...request.operation, homeKey: "foreign-home" },
      {
        ...request.operation,
        request: { ...request.operation.request, threadId: "foreign-thread" },
      },
      {
        ...request.operation,
        request: {
          ...request.operation.request,
          model: { ...request.operation.request.model, runtimePin: { ...pin, revision: 2 } },
        },
      },
    ])
      await bridge.hub.request({ ...request, id: `refused-${sent.length}`, operation }, worker);
    expect(sent).toEqual([request]);
    await bridge.hub.request(
      { ...request, id: "foreign-owner", scope: { ...request.scope, userId: "member" } },
      worker,
    );
    expect(sent).toEqual([request]);
    bridge.hub.detach();
    bridge.hub.attach(host, "owner", "revoked-generation");
    await bridge.hub.request({ ...request, id: "revoked" }, worker);
    expect(sent).toEqual([request]);
    bridge.hub.detach();
  });
});
