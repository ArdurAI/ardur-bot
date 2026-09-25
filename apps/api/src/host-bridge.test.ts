import { readFileSync } from "node:fs";
import type { Actor } from "@ardurbot/contracts";
import type { HostFrame, HostOperation, HostRequest } from "@ardurbot/contracts/host-bridge";
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
    spaceMember: {
      findFirst: vi.fn(async () => ({
        userId: "owner",
        spaceId: "space",
        member: { user: { email: "owner@example.test" } },
      })),
    },
    run: { findFirst: vi.fn(async () => null) },
    mcpServer: {
      findFirst: vi.fn(async () => ({ id: "server", enabled: true, catalogId: null })),
    },
    botMcpServer: {
      findFirst: vi.fn(async () => ({
        allowedTools: ["read_fixture"],
        allowAllTools: false,
        needsReview: false,
      })),
    },
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

describe.each(["editor", "settings"] as const)("shared %s host grants", (kind) => {
  const actor: Actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  const operation: HostOperation =
    kind === "editor"
      ? {
          op: "computer.files.read",
          homeKey: "ide",
          path: "/workspace/project/main.ts",
          editor: true,
        }
      : { op: "mcp.status", serverId: "server", revision: 1 };
  const open = (bridge: HostBridge) =>
    kind === "editor" ? bridge.ownerFile(actor, operation) : bridge.result(operation, actor);

  async function grantFixture() {
    const { bridge, prisma } = fixture();
    await bridge.pair("owner");
    const registration = (await prisma.hostRegistration.findUnique())!;
    registration.hostRoots = ["/workspace/project"];
    let forwarded!: (request: HostRequest) => void;
    const received = new Promise<HostRequest>((resolve) => {
      forwarded = resolve;
    });
    const host = {
      send: vi.fn(async (frame: HostFrame) => {
        if (frame.type === "request") forwarded(frame);
      }),
      close: vi.fn(),
    };
    bridge.hub.attach(host, "owner", registration.generation);
    return { bridge, prisma, registration, host, received };
  }

  it("acknowledges streams, finishes on end and rejects replayed grants", async () => {
    const { bridge, prisma, host, received } = await grantFixture();
    try {
      const result = open(bridge);
      const request = await received;
      const value = kind === "editor" ? Buffer.from("saved text").toString("base64") : { ok: true };
      await bridge.hub.fromHost(host, {
        v: 1,
        type: "stream",
        id: request.id,
        seq: 0,
        channel: kind === "editor" ? "file" : "result",
        data: value,
      });
      expect(host.send).toHaveBeenCalledWith({ v: 1, type: "ack", id: request.id, seq: 0 });
      await bridge.hub.fromHost(host, { v: 1, type: "end", id: request.id });
      if (kind === "editor")
        expect(await result).toMatchObject({ bytes: new Uint8Array(Buffer.from("saved text")) });
      else expect(await result).toEqual(value);
      expect(prisma.run.findFirst).not.toHaveBeenCalled();
      expect(prisma.spaceMember.findFirst).toHaveBeenCalled();
      const worker = { send: vi.fn(async (_frame: HostFrame) => {}), close: vi.fn() };
      await bridge.hub.request({ ...request, id: "replayed-grant" }, worker);
      expect(worker.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "end", problem: expect.any(Object) }),
      );
      expect(host.send.mock.calls.filter(([frame]) => frame.type === "request")).toHaveLength(1);
    } finally {
      bridge.hub.detach();
    }
  });

  it.each(["generation", "registration owner", "deployment owner", "membership"])(
    "refuses requests and responses after revoking %s",
    async (revoked) => {
      const { bridge, prisma, registration, host, received } = await grantFixture();
      try {
        const result = open(bridge);
        const rejection = expect(result).rejects.toThrow();
        const request = await received;
        if (revoked === "generation") registration.generation = "revoked";
        else if (revoked === "registration owner") registration.userId = "foreign";
        else if (revoked === "deployment owner")
          prisma.deploymentSettings.findUnique.mockResolvedValue({ ownerUserId: "foreign" });
        else prisma.spaceMember.findFirst.mockResolvedValue(null as never);
        await bridge.hub.fromHost(host, {
          v: 1,
          type: "stream",
          id: request.id,
          seq: 0,
          channel: "result",
          data: "must not escape",
        });
        await rejection;
        expect(host.send).toHaveBeenCalledWith({ v: 1, type: "cancel", id: request.id });
        await expect(open(bridge)).rejects.toThrow();
        expect(host.send.mock.calls.filter(([frame]) => frame.type === "request")).toHaveLength(1);
      } finally {
        bridge.hub.detach();
      }
    },
  );
});

it("keeps MCP calls tied to active bot runs and tool grants alongside settings requests", async () => {
  const { bridge, prisma } = fixture();
  await bridge.pair("owner");
  const registration = (await prisma.hostRegistration.findUnique())!;
  const host = { send: vi.fn(async (_frame: HostFrame) => {}), close: vi.fn() };
  const worker = { send: vi.fn(async (_frame: HostFrame) => {}), close: vi.fn() };
  bridge.hub.attach(host, "owner", registration.generation);
  const request: HostRequest = {
    v: 1,
    type: "request",
    id: "call",
    scope: { userId: "owner", spaceId: "space", botId: "bot", runId: "run" },
    operation: { op: "mcp.call", serverId: "server", revision: 1, name: "read_fixture", args: {} },
  };
  try {
    await expect(bridge.result(request.operation, request.scope)).rejects.toThrow("active bot run");
    await bridge.hub.request({ ...request, id: "missing-run" }, worker);
    expect(host.send).not.toHaveBeenCalled();
    prisma.run.findFirst.mockResolvedValue({ id: "run" } as never);
    await bridge.hub.request(request, worker);
    expect(host.send).toHaveBeenCalledExactlyOnceWith(request);
    prisma.botMcpServer.findFirst.mockResolvedValue({
      allowedTools: [],
      allowAllTools: false,
      needsReview: true,
    });
    await bridge.hub.fromHost(host, {
      v: 1,
      type: "stream",
      id: request.id,
      seq: 0,
      channel: "result",
      data: "must not escape",
    });
    expect(worker.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "stream" }));
    expect(host.send).toHaveBeenLastCalledWith({ v: 1, type: "cancel", id: request.id });
  } finally {
    bridge.hub.detach();
  }
});

it("grants owner editor files only inside current roots and never accepts a worker-forged grant", async () => {
  const { bridge, prisma } = fixture();
  await bridge.pair("owner");
  const registration = (await prisma.hostRegistration.findUnique())!;
  registration.hostRoots = ["/workspace/project"];
  const actor: Actor = {
    userId: "owner",
    spaceId: "space",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  const host = {
    send: vi.fn(async (frame: HostFrame) => {
      if (frame.type !== "request") return;
      await bridge.hub.fromHost(host, {
        v: 1,
        type: "stream",
        id: frame.id,
        seq: 0,
        channel: "file",
        data: Buffer.from("file text").toString("base64"),
      });
      await bridge.hub.fromHost(host, { v: 1, type: "end", id: frame.id });
    }),
    close: vi.fn(),
  };
  bridge.hub.attach(host, "owner", registration.generation);
  const operation = {
    op: "computer.files.read",
    homeKey: "ide",
    path: "/workspace/project/main.ts",
    editor: true,
  } as const;
  expect(Buffer.from((await bridge.ownerFile(actor, operation)).bytes).toString()).toBe(
    "file text",
  );
  expect(prisma.run.findFirst).not.toHaveBeenCalled();
  await expect(bridge.ownerFile({ ...actor, isDeploymentOwner: false }, operation)).rejects.toThrow(
    "owner",
  );
  await expect(
    bridge.ownerFile(actor, { ...operation, path: "/workspace/project-other/main.ts" }),
  ).rejects.toThrow("unavailable");
  const worker = { send: vi.fn(async (_frame: HostFrame) => {}), close: vi.fn() };
  const granted = host.send.mock.calls.find(
    ([frame]) => frame.type === "request",
  )![0] as HostRequest;
  await bridge.hub.request({ ...granted, id: "forged" }, worker);
  expect(worker.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "end", problem: expect.any(Object) }),
  );
  registration.hostRoots = [];
  await expect(bridge.ownerFile(actor, operation)).rejects.toThrow("unavailable");
  bridge.hub.detach();
});
