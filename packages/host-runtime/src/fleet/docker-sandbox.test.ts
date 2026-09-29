import type { AdapterContext } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { COMPUTER_IMAGE_PINS } from "@ardurbot/contracts/computer-image";
import { expect, it, vi } from "vitest";
import { connectionComputerImage } from "./computer-image.js";
import { engineCommand, engineLimits, FleetDockerSandboxProvider } from "./docker-sandbox.js";
import { fleetComputerKey } from "./linux-sandbox.js";
import type { FleetProcess } from "./process.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  userId: "owner",
  spaceId: "space",
  signal: new AbortController().signal,
};
it.each([true, false])(
  "provisions an engine-owned home with network egress = %s",
  async (networkEgress) => {
    const run = vi.fn(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }));
    const provider = new FleetDockerSandboxProvider(
      ComputerConnectionSettingsSchema.parse({
        engine: "docker",
        endpoint: "unix:///fixture/engine.sock",
      }),
      { run, start: vi.fn() } as FleetProcess,
    );
    const computer = await provider.provision(
      { botId: "bot", homePath: "/ignored", networkEgress },
      context,
    );
    const calls = run.mock.calls as unknown as [string, string[]][];
    const argv = calls.find(
      ([, args]) => args.includes("create") && args.includes("--cap-drop"),
    )![1];
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
    expect(computer).toMatchObject({ kind: "remote-docker", fresh: true, networkEgress });
    if (!networkEgress)
      expect(argv.slice(argv.indexOf("--network"), argv.indexOf("--network") + 2)).toEqual([
        "--network",
        "none",
      ]);
    else expect(argv).not.toContain("--network");
    expect(calls.some(([, args]) => args.includes("pull"))).toBe(false);
  },
);
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

it("uses the successful Test response after a failed capacity sample was cached", async () => {
  let running = false;
  const run = vi.fn(async () => ({
    code: running ? 0 : 1,
    stdout: Buffer.from(
      JSON.stringify({
        OSType: "linux",
        NCPU: 4,
        MemTotal: 8 * 1024 ** 3,
        ServerVersion: "fixture",
      }),
    ),
    stderr: Buffer.from(running ? "" : "connection refused"),
  }));
  const provider = new FleetDockerSandboxProvider(
    ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "unix:///fixture/engine.sock",
    }),
    { run, start: vi.fn() } as FleetProcess,
  );
  expect((await provider.capacity()).source).toBe("not-reported");
  running = true;
  const tested = await provider.test(context);
  expect(tested.capacity).toMatchObject({ source: "docker", memoryTotal: 8 * 1024 ** 3 });
});
it("uses the connection's image and names a missing one instead of pulling", async () => {
  const image = "registry.example/private/computer:1";
  let present = true;
  const run = vi.fn(async (_name: string, args: string[]) => ({
    code: args.includes("image") && !present ? 1 : 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(args.includes("image") && !present ? `Error: No such image: ${image}` : ""),
  }));
  const provider = new FleetDockerSandboxProvider(
    ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "unix:///fixture/engine.sock",
      standardImage: image,
    }),
    { run, start: vi.fn() } as FleetProcess,
  );
  await provider.provision({ botId: "bot", homePath: "/ignored" }, context);
  expect(run.mock.calls.find(([, args]) => args.includes("inspect"))?.[1]).toContain(image);
  expect(run.mock.calls.find(([, args]) => args.includes("--cap-drop"))?.[1]).toContain(image);
  present = false;
  run.mockClear();
  await expect(
    provider.provision({ botId: "other", homePath: "/ignored" }, context),
  ).rejects.toThrow(`Pull ${image} into this engine, then try again.`);
  expect(run.mock.calls.some(([, args]) => args.includes("create") || args.includes("pull"))).toBe(
    false,
  );
});

function mockEngineWithContainer(existingImage: string, running = true) {
  const name = `ardurbot-${fleetComputerKey(context.spaceId, "bot").slice(0, 40)}`;
  const volume = `${name}-home`;
  const run = vi.fn(async (_cmd: string, args: string[]) => {
    if (
      args.includes("container") &&
      args.includes("ls") &&
      args.some((a) => a.includes(`label=ardurbot.com/computer=${name}`))
    ) {
      return { code: 0, stdout: Buffer.from("existing-id\n"), stderr: Buffer.alloc(0) };
    }
    if (args.includes("inspect") && args.includes("--type") && args.includes("container")) {
      return {
        code: 0,
        stdout: Buffer.from(
          JSON.stringify([
            {
              Config: {
                Image: existingImage,
                Labels: {
                  "ardurbot.com/computer": name,
                  "ardurbot.com/space": context.spaceId,
                },
              },
              State: { Running: running },
              HostConfig: { NetworkMode: "bridge" },
            },
          ]),
        ),
        stderr: Buffer.alloc(0),
      };
    }
    if (args.includes("volume") && args.includes("ls")) {
      return { code: 0, stdout: Buffer.from(`${volume}\n`), stderr: Buffer.alloc(0) };
    }
    if (args.includes("volume") && args.includes("inspect")) {
      return {
        code: 0,
        stdout: Buffer.from(
          JSON.stringify([
            {
              Labels: {
                "ardurbot.com/computer": name,
                "ardurbot.com/space": context.spaceId,
              },
            },
          ]),
        ),
        stderr: Buffer.alloc(0),
      };
    }
    return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  return { name, volume, run };
}

it("recreates a legacy-tag container and keeps its home volume", async () => {
  const legacyImage = COMPUTER_IMAGE_PINS.base.tag;
  const defaultImage = connectionComputerImage("base", {});
  const { name, run } = mockEngineWithContainer(legacyImage, false);
  const provider = new FleetDockerSandboxProvider(
    ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "unix:///fixture/engine.sock",
    }),
    { run, start: vi.fn() } as FleetProcess,
  );
  const computer = await provider.provision({ botId: "bot", homePath: "/ignored" }, context);
  expect(computer.fresh).toBe(true);
  const rmCall = run.mock.calls.find(([, args]) => args.includes("rm") && args.includes("-f"));
  expect(rmCall?.[1]).toContain(name);
  const createCall = run.mock.calls.find(
    ([, args]) => args.includes("create") && args.includes("--name"),
  );
  expect(createCall?.[1]).toContain(defaultImage);
  expect(createCall?.[1]).toContain(`type=volume,src=${name}-home,dst=/home/ardurbot`);
  expect(run.mock.calls.some(([, args]) => args.includes("volume") && args.includes("create"))).toBe(
    false,
  );
  expect(run.mock.calls.some(([, args]) => args.includes("volume") && args.includes("rm"))).toBe(
    false,
  );
});

it("throws when an existing container has a user-changed image", async () => {
  const { run } = mockEngineWithContainer("registry.example/custom:v1");
  const provider = new FleetDockerSandboxProvider(
    ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "unix:///fixture/engine.sock",
      standardImage: "registry.example/custom:v2",
    }),
    { run, start: vi.fn() } as FleetProcess,
  );
  await expect(
    provider.provision({ botId: "bot", homePath: "/ignored" }, context),
  ).rejects.toThrow(
    "The computer image differs from its saved profile; confirm an update in Computers.",
  );
  expect(run.mock.calls.some(([, args]) => args.includes("rm"))).toBe(false);
  expect(run.mock.calls.some(([, args]) => args.includes("create"))).toBe(false);
});

it("leaves a matching image alone", async () => {
  const defaultImage = connectionComputerImage("base", {});
  const { run } = mockEngineWithContainer(defaultImage, true);
  const provider = new FleetDockerSandboxProvider(
    ComputerConnectionSettingsSchema.parse({
      engine: "docker",
      endpoint: "unix:///fixture/engine.sock",
    }),
    { run, start: vi.fn() } as FleetProcess,
  );
  const computer = await provider.provision({ botId: "bot", homePath: "/ignored" }, context);
  expect(computer.fresh).toBe(false);
  expect(run.mock.calls.some(([, args]) => args.includes("rm"))).toBe(false);
  expect(run.mock.calls.some(([, args]) => args.includes("create"))).toBe(false);
  expect(run.mock.calls.some(([, args]) => args.includes("start"))).toBe(false);
});
