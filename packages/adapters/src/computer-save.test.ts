import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher, PortableFile } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema, ComputerWorkspaceSaveError } from "@ardurbot/contracts";
import { RemoteComputerCallSchema } from "@ardurbot/contracts/fleet-bridge";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { readFleetArchive, writeFleetArchive } from "@ardurbot/host-runtime/fleet/archive";
import { FleetDockerSandboxProvider } from "@ardurbot/host-runtime/fleet/docker-sandbox";
import { fleetComputerKey } from "@ardurbot/host-runtime/fleet/linux-sandbox";
import {
  LINUX_ARCHIVE_SCRIPT,
  LINUX_FILE_SCRIPT,
  LINUX_RESTORE_SCRIPT,
} from "@ardurbot/host-runtime/fleet/linux-scripts";
import type { FleetProcess } from "@ardurbot/host-runtime/fleet/process";
import { FleetService } from "@ardurbot/host-runtime/fleet/service";
import type { HostClient, HostStreamFrame } from "@ardurbot/host-runtime/host-client";
import { expect, it, vi } from "vitest";
import { replaceComputer } from "./computer-lifecycle.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { RemoteFleetSandbox } from "./fleet/remote-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context: AdapterContext = {
  operationId: "update",
  traceId: "update",
  spaceId: "space",
  userId: "owner",
  botId: "bot",
  signal: new AbortController().signal,
};

it.each(["move", "reset"])("still saves a host workspace before %s", async (operation) => {
  const root = await mkdtemp(path.join(tmpdir(), "host-save-"));
  const source = new DesktopSandboxProvider({ root });
  const target = operation === "move" ? new FakeSandboxProvider() : undefined;
  const home = new LocalAgentHomeStore(path.join(root, "homes"));
  try {
    const first = await source.provision({ botId: "bot", homePath: root }, context);
    await source.writeFile(first, {
      path: "keep.txt",
      content: new TextEncoder().encode("local work"),
    });
    const row = {
      id: "host",
      homeKey: "bot",
      kind: "desktop",
      connectionId: null,
      providerRef: first.providerRef as string | null,
      state: "running",
      scope: "dedicated",
      maintenanceId: null,
      controlHolder: "none",
      controlLeaseId: null,
      updatedAt: new Date(0),
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: async () => ({ ...row }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return { count: 1 };
        },
      },
      run: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const exported = vi.spyOn(source, "exportWorkspace");
    const destroyed = vi.spyOn(source, "destroy");
    const moved = await replaceComputer(
      {
        prisma,
        sandbox: source,
        home,
        jobs: {} as JobPublisher,
        events: {} as ThreadEvents,
        dataDir: root,
      },
      row.id,
      operation === "reset" ? "reset" : "update",
      context,
      "none",
      undefined,
      undefined,
      target,
    );
    expect(exported).toHaveBeenCalledOnce();
    expect(exported.mock.invocationCallOrder[0]).toBeLessThan(
      destroyed.mock.invocationCallOrder[0]!,
    );
    expect(await home.readFile("bot", "keep.txt", context)).toBe("local work");
    expect(
      new TextDecoder().decode(await (target ?? source).readFile(moved, "keep.txt", context)),
    ).toBe("local work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const saveScenarios = [
  "update",
  "move",
  "missing-container",
  "missing-volume",
  "wrong-mount",
  "wrong-computer-label",
  "wrong-space-label",
  "wrong-volume-label",
  "wrong-volume-space",
  "stale-reference",
  "unreachable",
  "stays-stopped",
  "too-large",
] as const;
it.each(
  saveScenarios.flatMap((scenario) =>
    ["docker", "podman"].flatMap((engine) => [
      { scenario, bridge: false, engine },
      { scenario, bridge: true, engine },
    ]),
  ),
)(
  "saves an error-state container through a scripted engine: $scenario, bridge $bridge, $engine",
  async ({ scenario, bridge, engine }) => {
    const root = await mkdtemp(path.join(tmpdir(), "computer-save-"));
    const name = `ardurbot-${fleetComputerKey("space", "bot").slice(0, 40)}`;
    const labels = { "ardurbot.com/computer": name, "ardurbot.com/space": "space" };
    let exists = scenario !== "missing-container";
    let volume = scenario !== "missing-volume";
    let running = false;
    let files: PortableFile[] = [
      { path: "keep.txt", content: new TextEncoder().encode("unsaved work") },
    ];
    const run = vi.fn(
      async (_command: string, args: string[], _signal: AbortSignal, input?: Uint8Array) => {
        let stdout = Buffer.alloc(0);
        if (scenario === "unreachable")
          return { code: 1, stdout, stderr: Buffer.from("connection refused private-detail") };
        if (args.includes("container") && args.includes("ls"))
          stdout = Buffer.from(exists ? "container-id" : "");
        else if (args.includes("inspect") && args.includes("container"))
          stdout = Buffer.from(
            JSON.stringify([
              {
                Config: {
                  Image: "fixture",
                  Labels: {
                    ...labels,
                    ...(scenario === "wrong-computer-label"
                      ? { "ardurbot.com/computer": "foreign" }
                      : {}),
                    ...(scenario === "wrong-space-label"
                      ? { "ardurbot.com/space": "foreign" }
                      : {}),
                  },
                },
                State: { Running: running },
                Mounts: [
                  {
                    Type: "volume",
                    Name: scenario === "wrong-mount" ? "another-home" : `${name}-home`,
                    Destination: "/home/ardurbot",
                  },
                ],
                HostConfig: { NetworkMode: "bridge" },
              },
            ]),
          );
        else if (args.includes("volume") && args.includes("ls"))
          stdout = Buffer.from(volume ? `${name}-home` : "");
        else if (args.includes("volume") && args.includes("inspect"))
          stdout = Buffer.from(
            JSON.stringify([
              {
                Labels: {
                  ...labels,
                  ...(scenario === "wrong-volume-label"
                    ? { "ardurbot.com/computer": "foreign" }
                    : {}),
                  ...(scenario === "wrong-volume-space" ? { "ardurbot.com/space": "foreign" } : {}),
                },
              },
            ]),
          );
        else if (args.includes("start")) running = scenario !== "stays-stopped";
        else if (args.includes("create") && args.includes("--name")) {
          exists = true;
          files = [];
        } else if (args.includes("create") && args.includes("volume")) volume = true;
        else if (args.includes("rm") && args.includes("volume")) volume = false;
        else if (args.includes("rm")) exists = false;
        else if (args.includes("stop")) running = false;
        else if (args.includes("exec")) {
          if (scenario === "too-large" && args.includes(LINUX_ARCHIVE_SCRIPT))
            throw new Error("Computer output exceeds its limit.");
          if (!running)
            return {
              code: 1,
              stdout,
              stderr: Buffer.from("container is not running private-detail"),
            };
          if (args.includes(LINUX_ARCHIVE_SCRIPT))
            stdout = await writeFleetArchive(
              (async function* () {
                if (args.at(-1) === "0") yield* files;
              })(),
            );
          if (args.includes(LINUX_RESTORE_SCRIPT))
            files = [...readFleetArchive(Buffer.from(input!))];
          const fileScript = args.indexOf(LINUX_FILE_SCRIPT);
          if (fileScript !== -1 && args[fileScript + 2] === "write") {
            files.push({ path: args[fileScript + 3]!, content: new Uint8Array(input!) });
          }
        }
        return { code: 0, stdout, stderr: Buffer.alloc(0) };
      },
    );
    const settings = ComputerConnectionSettingsSchema.parse({
      engine,
      endpoint: "unix:///fixture/engine.sock",
      standardImage: "fixture",
    });
    const direct = new FleetDockerSandboxProvider(settings, {
      run,
      start: vi.fn(),
    } as FleetProcess);
    const service = new FleetService(root, "fixture-material");
    const provider = vi.spyOn(service, "provider").mockReturnValue(direct);
    const actions: string[] = [];
    const client: Pick<HostClient, "request"> = {
      async *request(operation, requestContext) {
        const call = RemoteComputerCallSchema.parse(JSON.parse(JSON.stringify(operation)));
        actions.push(call.action.type);
        const frames: HostStreamFrame[] = [];
        await service.call(call, requestContext as AdapterContext, async (channel, data) => {
          frames.push({
            v: 1,
            type: "stream",
            id: "fixture",
            seq: frames.length,
            channel,
            data: JSON.parse(JSON.stringify(data)),
          });
        });
        yield* frames;
      },
    };
    const source = bridge ? new RemoteFleetSandbox("engine", settings, client) : direct;
    const target = scenario === "move" ? new FakeSandboxProvider() : undefined;
    const row = {
      id: "computer",
      homeKey: "bot",
      kind: "remote-docker",
      connectionId: "engine",
      scope: "dedicated",
      state: "error",
      providerRef: (scenario === "stale-reference" ? "foreign" : name) as string | null,
      homeRevision: "old",
      maintenanceId: null,
      controlHolder: "none",
      controlLeaseId: null,
      networkEgress: true,
      imageProfile: "base",
      updatedAt: new Date(0),
    };
    const prisma = {
      computer: {
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      run: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const home = new LocalAgentHomeStore(path.join(root, "homes"));
    try {
      const work = replaceComputer(
        {
          prisma,
          sandbox: source,
          home,
          jobs: {} as JobPublisher,
          events: {} as ThreadEvents,
          dataDir: root,
        },
        row.id,
        "update",
        context,
        "none",
        undefined,
        undefined,
        target,
      );
      if (scenario === "update" || scenario === "move") {
        const result = await work;
        expect(row.state).toBe("running");
        expect(await home.readFile("bot", "keep.txt", context)).toBe("unsaved work");
        if (target)
          expect(new TextDecoder().decode(await target.readFile(result, "keep.txt", context))).toBe(
            "unsaved work",
          );
        else expect(new TextDecoder().decode(files[0]!.content)).toBe("unsaved work");
        const commands = run.mock.calls.map(([, args]) => args);
        expect(commands.findIndex((args) => args.includes("start"))).toBeLessThan(
          commands.findIndex((args) => args.includes(LINUX_ARCHIVE_SCRIPT)),
        );
        if (bridge)
          expect(actions.indexOf("workspace.ready")).toBeLessThan(actions.indexOf("export"));
      } else {
        await expect(work).rejects.toBeInstanceOf(ComputerWorkspaceSaveError);
        await expect(work).rejects.toMatchObject({
          reason:
            scenario === "unreachable"
              ? "engine-unreachable"
              : scenario === "stays-stopped"
                ? "source-not-running"
                : scenario === "too-large"
                  ? "too-large"
                  : (scenario.startsWith("wrong-") && scenario !== "wrong-mount") ||
                      scenario === "stale-reference"
                    ? "save-failed"
                    : "source-missing",
        });
        expect(row.state).toBe("error");
        expect(row.homeRevision).toBe("old");
        if (
          scenario.startsWith("wrong-") ||
          scenario === "stale-reference" ||
          scenario.startsWith("missing-")
        ) {
          expect(
            run.mock.calls.some(([, args]) => args.includes("start") || args.includes("exec")),
          ).toBe(false);
        }
        expect(
          run.mock.calls.some(([, args]) => args.includes("rm") || args.includes("create")),
        ).toBe(false);
      }
    } finally {
      provider.mockRestore();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
