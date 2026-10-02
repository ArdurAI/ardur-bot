import type { AgentRuntime } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import { COMPUTER_KINDS, RuntimeKindSchema, runtimeSupportsLocation } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { expect, it, vi } from "vitest";
import { runtimeComputerLocation } from "./runtime-computer-location.js";
import { RuntimeRegistry } from "./runtime-registry.js";

const pin: RuntimePin = {
  runtimeKind: "pi",
  provider: "example",
  modelId: "model",
  credentialId: "key",
  effort: "off",
  revision: 0,
};
const locations = [
  ...Object.keys(COMPUTER_KINDS).map((kind) => ({ kind })),
  ...(["docker", "podman", "kubernetes", "ssh"] as const).map((engine) => ({
    kind: "desktop",
    connectionId: "saved",
    connectionSettings: { engine },
  })),
  { kind: "desktop", connectionId: "missing" },
  { kind: "desktop", connectionId: "" },
];
it.each(RuntimeKindSchema.options)(
  "%s server admission uses the shared table before any probe",
  async (runtimeKind) => {
    for (const location of locations) {
      const runtime = {} as AgentRuntime;
      const modelId = runtimeKind === "antigravity" ? "gemini-3.1-pro-high" : "model";
      const probe = vi.fn(async () => ({
        runtimeKind,
        available: true,
        models: [{ id: modelId, label: "Model", efforts: ["off"] }],
      }));
      const factory = vi.fn(() => runtime);
      const registry = new RuntimeRegistry({ [runtimeKind]: { probe, factory } });
      const requested = {
        ...pin,
        runtimeKind,
        ...(runtimeKind === "antigravity"
          ? { modelId, provider: "antigravity", credentialId: "native:antigravity", effort: "high" }
          : {}),
      };
      const result = await registry.resolve(requested, location, true, {
        credentialId: "key",
        provider: "example",
        modelId: "model",
        effort: "off",
      });
      if (runtimeSupportsLocation(runtimeKind, location)) {
        expect(result).toMatchObject({ runtime });
        expect(probe).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({
          kind: "problem",
          code: "runtime-unsupported-computer",
          reasonId: "computer-unsupported",
          pin: requested,
        });
        expect(probe).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
      }
    }
  },
);
it.each(["docker", "podman", "kubernetes", "ssh", null])(
  "resolves a legacy desktop connection (%s) within its space",
  async (engine) => {
    const findFirst = vi.fn(async () => (engine ? { metadata: { engine } } : null));
    const prisma = { connection: { findFirst } } as unknown as PrismaClient;
    const location = await runtimeComputerLocation(prisma, {
      kind: "desktop",
      connectionId: "saved",
      spaceId: "space",
    });
    expect(runtimeSupportsLocation("codex-app-server", location)).toBe(false);
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: "saved", spaceId: "space", connectorId: "computer" },
    });
  },
);
it("does not read a connection for a connectionless host", async () => {
  const findFirst = vi.fn();
  const location = await runtimeComputerLocation(
    { connection: { findFirst } } as unknown as PrismaClient,
    { kind: "desktop", connectionId: null, spaceId: "space" },
  );
  expect(runtimeSupportsLocation("hermes", location)).toBe(true);
  expect(findFirst).not.toHaveBeenCalled();
});
it("fails closed for a malformed empty saved connection", async () => {
  const findFirst = vi.fn();
  const location = await runtimeComputerLocation(
    { connection: { findFirst } } as unknown as PrismaClient,
    { kind: "desktop", connectionId: "", spaceId: "space" },
  );
  for (const runtime of RuntimeKindSchema.options)
    expect(runtimeSupportsLocation(runtime, location)).toBe(false);
  expect(findFirst).not.toHaveBeenCalled();
});
