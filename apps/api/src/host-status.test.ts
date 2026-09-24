import type { PrismaClient } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ inspect: vi.fn(), owner: vi.fn() }));
vi.mock("@ardurbot/adapters", () => ({ nativeHostOwner: fake.owner }));
vi.mock("@ardurbot/host-runtime/host-environment", () => ({
  getHostEnvironment: async () => ({ env: { PATH: "/fixture/bin" } }),
  inspectHostEnvironment: fake.inspect,
}));
vi.mock("@ardurbot/host-runtime/runtimes/claude-code-runtime", () => ({
  probeClaude: async () => ({ runtimeKind: "claude-code", available: false, models: [] }),
}));
vi.mock("@ardurbot/host-runtime/runtimes/codex-app-server-runtime", () => ({
  probeCodex: async () => ({ runtimeKind: "codex-app-server", available: false, models: [] }),
}));

import { sourceHostStatus } from "./host-status.js";

const prisma = {
  deploymentSettings: { findUnique: async () => ({ computerHost: "this-mac" }) },
} as unknown as PrismaClient;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("shows source host inventory to its sole owner without offering a paired disconnect", async () => {
  fake.owner.mockResolvedValue(true);
  fake.inspect.mockResolvedValue({
    tools: [{ name: "gh", status: "signed in" }],
    diagnostic:
      "Your login shell profile failed to load (zsh, exit 1); commands run with a default PATH",
  });
  expect(await sourceHostStatus(prisma, "owner", "docker")).toMatchObject({
    configured: false,
    connected: true,
    health: { environment: { tools: [{ name: "gh", status: "signed in" }] } },
  });
  await sourceHostStatus(prisma, "owner", "docker");
  expect(fake.inspect).toHaveBeenCalledOnce();
  expect(fake.inspect).toHaveBeenCalledWith(expect.any(Promise), false);
});
it("never probes a packaged API container, another user's host, or a container-only deployment", async () => {
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  expect(await sourceHostStatus(prisma, "owner", "docker")).toBeNull();
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  fake.owner.mockResolvedValue(false);
  expect(await sourceHostStatus(prisma, "other", "docker")).toBeNull();
  fake.owner.mockResolvedValue(true);
  expect(await sourceHostStatus(prisma, "owner", "fake")).toBeNull();
  expect(fake.inspect).not.toHaveBeenCalled();
});
