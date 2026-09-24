import type { HostFrame, HostRequest } from "@ardurbot/contracts";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { KUBERNETES_FILE_SCRIPT } from "@ardurbot/host-runtime/fleet/kubernetes-files";
import { expect, it, vi } from "vitest";
import { HostBridge } from "./host-bridge.js";

const settings = ComputerConnectionSettingsSchema.parse({
  engine: "ssh",
  ssh: { host: "computer.invalid", user: "runner" },
});
function fixture() {
  const computer = {
    id: "computer",
    homeKey: "home",
    connectionId: "connection",
    controlBotId: "bot",
    controlLeaseId: "lease",
    controlFence: 3,
    controlLeaseExpiresAt: new Date(Date.now() + 60000),
    maintenanceId: "move",
  };
  const prisma = {
    hostRegistration: {
      findUnique: vi.fn(async () => ({ userId: "owner", generation: "generation" })),
    },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "owner" })) },
    spaceMember: { findFirst: vi.fn(async () => ({})) },
    connection: { findFirst: vi.fn(async () => ({ metadata: settings })) },
    bot: { findFirst: vi.fn(async () => ({ id: "bot", computer })) },
    run: { findFirst: vi.fn(async () => ({ id: "run" })) },
    computerUpdate: { findFirst: vi.fn(async () => ({ id: "move" })) },
  };
  const bridge = new HostBridge(prisma as unknown as PrismaClient, "fixture-material");
  const sent: HostFrame[] = [];
  const host = {
    send: vi.fn(async (frame: HostFrame) => {
      sent.push(frame);
    }),
    close: vi.fn(),
  };
  const worker = { send: vi.fn(async () => undefined), close: vi.fn() };
  bridge.hub.attach(host, "owner", "generation");
  const request: HostRequest = {
    v: 1,
    type: "request",
    id: "request",
    scope: { userId: "owner", spaceId: "space", botId: "bot", runId: "run" },
    operation: {
      op: "computer.remote.call",
      connectionId: "connection",
      homeKey: "home",
      settings,
      action: { type: "exec", argv: ["bash", "-c", "echo command"] },
    },
  };
  return { prisma, bridge, host, worker, sent, request };
}
it("keeps remote execution bound to an active owner run and its exact saved connection", async () => {
  const f = fixture();
  try {
    await f.bridge.hub.request(f.request, f.worker);
    expect(f.sent).toEqual([f.request]);
    expect(f.prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "running",
          cancelRequestedAt: null,
          userId: "owner",
          botId: "bot",
        }),
      }),
    );
  } finally {
    f.bridge.hub.detach();
  }
});
it.each(["inactive", "home", "settings", "member", "terminal"])(
  "refuses a forged or stale remote grant: %s",
  async (failure) => {
    const f = fixture();
    if (failure === "inactive") f.prisma.run.findFirst.mockResolvedValue(null as never);
    if (failure === "member") f.prisma.spaceMember.findFirst.mockResolvedValue(null as never);
    if (f.request.operation.op === "computer.remote.call") {
      if (failure === "home") f.request.operation.homeKey = "different";
      if (failure === "settings")
        f.request.operation.settings = {
          ...settings,
          ssh: { ...settings.ssh!, host: "different.invalid" },
        };
      if (failure === "terminal")
        f.request.operation.action = {
          type: "terminal.open",
          leaseId: "lease",
          fence: 2,
          generation: "generation",
          cols: 80,
          rows: 24,
          shellProfileId: "default",
          expiresAt: Date.now() + 30000,
          workingRoot: "",
        };
    }
    try {
      await f.bridge.hub.request(f.request, f.worker);
      expect(f.sent).toEqual([]);
      expect(f.worker.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "end", problem: expect.any(Object) }),
      );
    } finally {
      f.bridge.hub.detach();
    }
  },
);
it("maintenance can prepare folders but cannot run arbitrary commands without a run", async () => {
  const f = fixture();
  f.prisma.run.findFirst.mockResolvedValue(null as never);
  if (f.request.operation.op === "computer.remote.call") f.request.operation.maintenanceId = "move";
  try {
    await f.bridge.hub.request(f.request, f.worker);
    expect(f.sent).toEqual([]);
  } finally {
    f.bridge.hub.detach();
  }
});

it.each([false, true])(
  "Kubernetes maintenance accepts confined file operations only: %s",
  async (confined) => {
    const f = fixture();
    f.prisma.run.findFirst.mockResolvedValue(null as never);
    if (f.request.operation.op !== "computer.remote.call") throw new Error("fixture");
    const kubeSettings = ComputerConnectionSettingsSchema.parse({
      engine: "kubernetes",
      context: "kind-test",
    });
    f.prisma.connection.findFirst.mockResolvedValue({ metadata: kubeSettings });
    f.request.operation.settings = kubeSettings;
    f.request.operation.maintenanceId = "move";
    f.request.operation.action = {
      type: "kube.exec",
      name: "computer",
      argv: confined
        ? ["python3", "-c", KUBERNETES_FILE_SCRIPT, "read", "marker", "", "128", "false"]
        : ["bash", "-c", "arbitrary-command"],
    };
    try {
      await f.bridge.hub.request(f.request, f.worker);
      expect(f.sent).toHaveLength(confined ? 1 : 0);
    } finally {
      f.bridge.hub.detach();
    }
  },
);
