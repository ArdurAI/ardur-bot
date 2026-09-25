import type { Actor } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => vi.fn(async () => ({ id: "update", status: "queued" })));
vi.mock("@ardurbot/adapters", async (original) => ({
  ...(await original<object>()),
  queueComputerUpdate: queue,
}));

import { createCapabilitySettings } from "./capability-settings.js";

const actor = { spaceId: "space", userId: "owner" } as Actor;
function fixture(role = "owner") {
  const computer = {
    id: "computer",
    homeKey: "home",
    kind: "docker",
    connectionId: "engine",
    providerRef: "container",
    networkEgress: true,
    maintenanceId: null,
    bots: [{ id: "bot", name: "Bot" }],
  };
  const space = {
    toolAccessMode: "when-needed",
    connectorSearch: false,
    inlineVisualizations: true,
  };
  const prisma = {
    spaceMember: { findUnique: vi.fn(async () => ({ role })) },
    space: {
      findUniqueOrThrow: vi.fn(async () => space),
      update: vi.fn(async ({ data }) => Object.assign(space, data)),
    },
    computer: { findFirst: vi.fn(async () => computer), findMany: vi.fn(async () => [computer]) },
  };
  const service = createCapabilitySettings({ prisma, jobs: {}, sandbox: {} } as never);
  queue.mockClear();
  return { service, prisma, computer };
}
describe("space capability authority", () => {
  it("defaults connector search off and persists an owner's choice", async () => {
    const f = fixture();
    expect((await f.service.settings(actor)).settings.connectorSearch).toBe(false);
    await f.service.configure(actor, { connectorSearch: true });
    expect((await f.service.settings(actor)).settings.connectorSearch).toBe(true);
    expect(f.prisma.space.update).toHaveBeenCalledWith({
      where: { id: "space" },
      data: { connectorSearch: true },
    });
  });
  it("makes another member read-only and refuses mutations", async () => {
    const f = fixture("member");
    expect((await f.service.settings(actor)).canConfigure).toBe(false);
    await expect(f.service.configure(actor, { connectorSearch: true })).rejects.toThrow();
    await expect(
      f.service.network(actor, { computerId: "computer", networkEgress: false, confirmed: true }),
    ).rejects.toThrow();
    expect(f.prisma.space.update).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });
  it("queues a confirmed space-scoped change with no engine fields", async () => {
    const f = fixture();
    await f.service.network(actor, {
      computerId: "computer",
      networkEgress: false,
      confirmed: true,
    });
    expect(f.prisma.computer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "computer", spaceId: "space" } }),
    );
    expect(queue).toHaveBeenCalledWith(expect.anything(), "computer", "bot", "update", {
      networkEgress: false,
      confirmed: true,
    });
    expect(f.computer.networkEgress).toBe(true);
    await expect(
      f.service.network(actor, {
        computerId: "computer",
        networkEgress: false,
        confirmed: false,
      } as never),
    ).rejects.toThrow();
    await expect(
      f.service.network(actor, {
        computerId: "computer",
        networkEgress: false,
        confirmed: true,
        connectionId: "foreign",
      } as never),
    ).rejects.toThrow();
    expect(queue).toHaveBeenCalledTimes(1);
  });
  it("labels Kubernetes unsupported when enforcement cannot be detected", async () => {
    const f = fixture();
    f.computer.kind = "kubernetes";
    expect((await f.service.settings(actor)).computers[0]?.supported).toBe(false);
    await expect(
      f.service.network(actor, { computerId: "computer", networkEgress: false, confirmed: true }),
    ).rejects.toThrow("unsupported");
    expect(queue).not.toHaveBeenCalled();
  });
});
