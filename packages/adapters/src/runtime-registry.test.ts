import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import {
  HERMES_SOURCE_PIN,
  HERMES_SOURCE_TREE,
} from "@ardurbot/host-runtime/runtimes/hermes-install";
import { describe, expect, it, vi } from "vitest";
import { nativeRuntimeAvailability, RuntimeRegistry } from "./runtime-registry.js";

vi.mock("../../host-runtime/python/hermes_sources.json", () => ({ default: {} }));

const pin: RuntimePin = {
  runtimeKind: "hermes",
  provider: "openai-compatible",
  modelId: "same-model",
  effort: "off",
  credentialId: "connection-one",
  revision: 1,
};
const connection = {
  credentialId: "connection-one",
  provider: "openai-compatible",
  modelId: "same-model",
  effort: "off",
};

describe("Hermes registry admission", () => {
  const make = (available: boolean) => {
    const runtime = {} as AgentRuntime;
    const factory = vi.fn(() => runtime);
    const probe = vi.fn(async () => ({
      runtimeKind: "hermes" as const,
      available,
      models: [],
      reason: available ? undefined : "Hermes is not installed on this computer.",
    }));
    return {
      runtime,
      factory,
      probe,
      registry: new RuntimeRegistry({ hermes: { factory, probe } }),
    };
  };

  it("matches the full connection, model, and effort without another runtime fallback", async () => {
    const f = make(true);
    expect(await f.registry.resolve(pin, "desktop", true, connection)).toMatchObject({
      runtime: f.runtime,
    });
    expect(
      await f.registry.resolve(pin, "desktop", true, {
        ...connection,
        credentialId: "connection-two",
      }),
    ).toMatchObject({ code: "pin-credential-missing" });
    expect(f.factory).toHaveBeenCalledOnce();
  });

  it("fails closed for a missing install, unsupported computer, and disabled experiment", async () => {
    const f = make(false);
    expect(await f.registry.resolve(pin, "desktop", true, connection)).toMatchObject({
      code: "runtime-unavailable",
    });
    expect(await f.registry.resolve(pin, "docker", true, connection)).toMatchObject({
      code: "runtime-unsupported-computer",
      reasonId: "computer-unsupported",
      reason:
        "Hermes runs on the host computer, not in a sandbox. Change this bot's computer to use it.",
      actions: ["change-pin"],
    });
    expect(await f.registry.resolve(pin, "desktop", false, connection)).toMatchObject({
      code: "runtime-unavailable",
      reasonId: "experimental-off",
      reason: "Hermes is experimental. Turn on Experimental for this bot to use it.",
      actions: ["change-pin"],
    });
    expect(f.factory).not.toHaveBeenCalled();
  });
});

describe("local Hermes availability", () => {
  it.skipIf(process.platform === "win32")(
    "probes the same managed install candidate the local runtime uses",
    async () => {
      const data = await mkdtemp(path.join(tmpdir(), "hermes-availability-"));
      vi.stubEnv("DATA_DIR", data);
      vi.stubEnv("ARDUR_HERMES_INSTALL", "");
      try {
        const managed = path.join(path.resolve(data), "hermes", "runtimes", "hermes-agent");
        await mkdir(path.join(managed, ".venv", "bin"), { recursive: true });
        await writeFile(path.join(managed, ".venv", "bin", "python"), "fixture");
        await writeFile(
          path.join(managed, ".ardur-install.json"),
          JSON.stringify({ pin: HERMES_SOURCE_PIN, tree: HERMES_SOURCE_TREE }),
        );
        const availability = await nativeRuntimeAvailability("hermes");
        expect(availability).toMatchObject({ runtimeKind: "hermes", available: true });
      } finally {
        vi.unstubAllEnvs();
        await rm(data, { recursive: true, force: true });
      }
    },
  );

  it("says Hermes is missing when this computer has no checkout", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "hermes-missing-"));
    vi.stubEnv("DATA_DIR", data);
    vi.stubEnv("ARDUR_HERMES_INSTALL", "");
    try {
      await expect(nativeRuntimeAvailability("hermes")).resolves.toMatchObject({
        runtimeKind: "hermes",
        available: false,
        reason: "Hermes is not installed on this computer.",
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(data, { recursive: true, force: true });
    }
  });

  it("says the safety check failed when the checkout is present but unsafe", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "hermes-unsafe-"));
    const install = path.join(data, "install");
    await mkdir(install, { recursive: true });
    await writeFile(path.join(install, ".env"), "fixture");
    vi.stubEnv("DATA_DIR", data);
    vi.stubEnv("ARDUR_HERMES_INSTALL", install);
    try {
      const availability = await nativeRuntimeAvailability("hermes");
      expect(availability).toMatchObject({
        runtimeKind: "hermes",
        available: false,
        reason: "The Hermes install on this computer failed its safety check.",
      });
      // An explicit install belongs to the operator: no reinstall offer.
      expect(availability.install).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      await rm(data, { recursive: true, force: true });
    }
  });

  it("offers reinstall when the managed install fails its safety check", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "hermes-managed-unsafe-"));
    const managed = path.join(path.resolve(data), "hermes", "runtimes", "hermes-agent");
    await mkdir(managed, { recursive: true });
    await writeFile(path.join(managed, ".env"), "fixture");
    vi.stubEnv("DATA_DIR", data);
    vi.stubEnv("ARDUR_HERMES_INSTALL", "");
    try {
      await expect(nativeRuntimeAvailability("hermes")).resolves.toMatchObject({
        runtimeKind: "hermes",
        available: false,
        reason: "The Hermes install on this computer failed its safety check.",
        install: { state: "absent" },
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(data, { recursive: true, force: true });
    }
  });

  it("says Hermes is not available on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("ARDUR_HERMES_INSTALL", "");
    try {
      await expect(nativeRuntimeAvailability("hermes")).resolves.toMatchObject({
        runtimeKind: "hermes",
        available: false,
        reason: "Hermes isn't available on Windows yet.",
      });
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
