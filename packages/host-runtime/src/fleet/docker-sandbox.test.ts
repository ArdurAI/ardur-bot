import type { AdapterContext } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import { engineCommand, engineLimits, FleetDockerSandboxProvider } from "./docker-sandbox.js";
import type { FleetProcess } from "./process.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  userId: "owner",
  spaceId: "space",
  signal: new AbortController().signal,
};
it("provisions an engine-owned home without published ports or host bind mounts", async () => {
  const run = vi.fn(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
  const provider = new FleetDockerSandboxProvider(
    ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "unix:///fixture/engine.sock",
    }),
    { run, start: vi.fn() } as FleetProcess,
  );
  const computer = await provider.provision({ botId: "bot", homePath: "/ignored" }, context);
  const calls = run.mock.calls as unknown as [string, string[]][];
  const argv = calls.find(([, args]) => args.includes("create") && args.includes("--cap-drop"))![1];
  expect(argv).toEqual(
    expect.arrayContaining([
      "--host",
      "unix:///fixture/engine.sock",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "1000:1000",
      "--cpus",
      "2",
      "--memory",
      "2147483648",
    ]),
  );
  expect(argv).not.toContain("--publish");
  expect(argv.join(" ")).not.toContain("type=bind");
  expect(computer).toMatchObject({ kind: "remote-docker", fresh: true });
  expect(calls.some(([, args]) => args.includes("pull"))).toBe(false);
});
it("refuses to reuse an engine volume without matching ownership labels", async () => {
  const run = vi.fn(async (_name: string, args: string[]) => ({
    code: 0,
    stderr: Buffer.alloc(0),
    stdout: Buffer.from(
      args.includes("volume") && args.includes("ls")
        ? "existing"
        : args.includes("volume") && args.includes("inspect")
          ? '[{"Labels":{}}]'
          : "",
    ),
  }));
  const provider = new FleetDockerSandboxProvider(
    ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "unix:///fixture/engine.sock",
    }),
    { run, start: vi.fn() } as FleetProcess,
  );
  await expect(provider.provision({ botId: "bot", homePath: "" }, context)).rejects.toThrow(
    "volume identity",
  );
  expect(run.mock.calls.some(([, args]) => args.includes("--cap-drop"))).toBe(false);
});
it.each(["docker", "podman"] as const)(
  "tests %s version, OS, CPU and memory without inventing TCP free memory",
  async (engine) => {
    const info =
      engine === "docker"
        ? {
            NCPU: 8,
            MemTotal: 16 * 1024 ** 3,
            OSType: "linux",
            OperatingSystem: "Linux",
            ServerVersion: "test-version",
            SecurityOptions: [],
          }
        : {
            host: {
              cpus: 8,
              memTotal: 16 * 1024 ** 3,
              memFree: 4 * 1024 ** 3,
              os: "linux",
              security: { rootless: true },
            },
            version: { Version: "test-version" },
          };
    const run = vi.fn(async () => ({
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(JSON.stringify(info)),
    }));
    const provider = new FleetDockerSandboxProvider(
      ComputerConnectionSettingsSchema.parse({ engine, endpoint: "tcp://computer.invalid:2376" }),
      { run, start: vi.fn() } as FleetProcess,
      async () => ({ ca: "test-ca", cert: "test-certificate", key: "test-private-material" }),
    );
    const result = await provider.test(context);
    expect(result.version).toBe("test-version");
    expect(result.capacity).toMatchObject({ cpuCount: 8, memoryTotal: 16 * 1024 ** 3 });
    if (engine === "docker") expect(result.capacity.memoryFree).toBeNull();
    else expect(result.capacity.memoryFree).toBe(4 * 1024 ** 3);
    expect(JSON.stringify(run.mock.calls)).not.toContain("test-private-material");
  },
);

it("pins discovered contexts to their tested endpoint and validates resource units", () => {
  const settings = ComputerConnectionSettingsSchema.parse({
    engine: "docker",
    endpoint: "unix:///fixture/pinned.sock",
    dockerContext: "editable-context",
    cpuLimit: "500m",
    memoryLimit: "256Mi",
  });
  expect(engineCommand(settings).prefix).toEqual(["--host", "unix:///fixture/pinned.sock"]);
  expect(engineLimits(settings)).toEqual(["--cpus", "0.5", "--memory", "268435456"]);
  expect(() => engineLimits({ ...settings, cpuLimit: "0" })).toThrow("resource limits");
});
