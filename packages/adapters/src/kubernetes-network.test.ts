import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { kubernetesPolicyEnforced } from "./kubernetes-network.js";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
describe("detected Kubernetes egress enforcement", () => {
  it("requires a ready enabled controller and no additive allow rules", () => {
    const input = { desired: 2, ready: 2, mode: "default", namespaceEgress: [], customPolicies: 0 };
    expect(kubernetesPolicyEnforced(input)).toBe(true);
    for (const patch of [
      { desired: 0 },
      { ready: 1 },
      { mode: "never" },
      { mode: "unknown" },
      { namespaceEgress: [{ egress: [{}] }] },
      { customPolicies: 1 },
    ])
      expect(kubernetesPolicyEnforced({ ...input, ...patch })).toBe(false);
  });
  it("fails before creating a computer when policy enforcement is unsupported", async () => {
    const api = { create: vi.fn(), supportsEgress: vi.fn(async () => false), setEgress: vi.fn() };
    const provider = new KubernetesSandboxProvider(
      api as never,
      ComputerConnectionSettingsSchema.parse({ engine: "kubernetes" }),
    );
    await expect(
      provider.provision({ botId: "bot", homePath: "/unused", networkEgress: false }, context),
    ).rejects.toThrow("unsupported");
    expect(api.create).not.toHaveBeenCalled();
    expect(api.setEgress).not.toHaveBeenCalled();
  });
  it("installs the policy before a replacement pod and preserves the network preference", async () => {
    const order: string[] = [];
    const api = {
      read: vi.fn(async () => null),
      create: vi.fn(async (resource: string) => {
        order.push(resource);
      }),
      supportsEgress: vi.fn(async () => true),
      setEgress: vi.fn(async () => {
        order.push("policy");
      }),
    };
    const provider = new KubernetesSandboxProvider(
      api as never,
      ComputerConnectionSettingsSchema.parse({ engine: "kubernetes" }),
    );
    expect(
      (
        await provider.provision(
          { botId: "bot", homePath: "/unused", networkEgress: false },
          context,
        )
      ).networkEgress,
    ).toBe(false);
    expect(order).toEqual(["policy", "persistentvolumeclaims", "pods"]);
  });
});
