import { describe, expect, it, vi } from "vitest";
import { NO_SANDBOX_MESSAGE } from "./none-sandbox.js";
import { createSandboxProvider } from "./sandbox-factory.js";

const ctx = {
  operationId: "op",
  traceId: "tr",
  spaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", () => {
    const sandbox = createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("returns none when requested or when the kind is empty", async () => {
    expect(createSandboxProvider("none", {}).describe().id).toBe("none");
    expect(createSandboxProvider("", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("none", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(NO_SANDBOX_MESSAGE);
  });

  it("returns provider-specific managed sandbox emulators", () => {
    expect(createSandboxProvider("e2b-emulator", {}).describe().id).toBe("e2b-emulator");
    expect(createSandboxProvider("daytona-emulator", {}).describe().id).toBe("daytona-emulator");
    expect(createSandboxProvider("box-emulator", {}).describe()).toMatchObject({
      id: "box-emulator",
      capabilities: { multiScreen: true },
    });
  });

  it("boots without a remote key and keeps computers unavailable", async () => {
    expect(createSandboxProvider("e2b", {}).describe().id).toBe("none");
    expect(createSandboxProvider("daytona", {}).describe().id).toBe("none");
    expect(createSandboxProvider("box", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("e2b", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/E2B_API_KEY/);
    expect(createSandboxProvider("box", { boxApiKey: "test-box-key" }).describe().id).toBe("box");
  });

  it("declares the kind of the computers each provider creates", () => {
    const created = (kind: string, keys = {}) => createSandboxProvider(kind, keys).describe();
    expect(created("e2b-emulator")).toMatchObject({ id: "e2b-emulator", kind: "e2b" });
    expect(created("daytona-emulator")).toMatchObject({ id: "daytona-emulator", kind: "daytona" });
    expect(created("box-emulator")).toMatchObject({ id: "box-emulator", kind: "box" });
    expect(created("e2b", { e2bApiKey: "e2b-test" })).toMatchObject({ id: "e2b", kind: "e2b" });
    expect(created("docker")).toMatchObject({ id: "docker", kind: "docker" });
    expect(created("fake")).toMatchObject({ id: "fake", kind: "fake" });
    expect(created("none")).toMatchObject({ id: "none", kind: null });
  });

  it("builds no Kubernetes provider from the process's own cluster credentials", () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    vi.stubEnv("KUBERNETES_SERVICE_PORT", "443");
    try {
      expect(() => createSandboxProvider("kubernetes", {})).toThrow(
        "Choose a Kubernetes connection in Settings → Computers.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use none | docker | kubernetes | e2b | daytona | box | e2b-emulator | daytona-emulator | box-emulator | desktop | fake.',
    );
  });
});
