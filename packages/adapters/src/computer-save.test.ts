import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import type { PrismaClient, ThreadEvents } from "@ardurbot/db";
import { readFleetArchive, writeFleetArchive } from "@ardurbot/host-runtime/fleet/archive";
import { FleetDockerSandboxProvider } from "@ardurbot/host-runtime/fleet/docker-sandbox";
import { fleetComputerKey } from "@ardurbot/host-runtime/fleet/linux-sandbox";
import {
  LINUX_ARCHIVE_SCRIPT,
  LINUX_RESTORE_SCRIPT,
} from "@ardurbot/host-runtime/fleet/linux-scripts";
import type { FleetProcess } from "@ardurbot/host-runtime/fleet/process";
import { expect, it, vi } from "vitest";
import { replaceComputer } from "./computer-lifecycle.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context: AdapterContext = {
  operationId: "update",
  traceId: "update",
  spaceId: "space",
  userId: "owner",
  botId: "bot",
  signal: new AbortController().signal,
};

it.each(["update", "move", "missing-container", "missing-volume", "unreachable", "stays-stopped"])(
  "saves an error-state container through a scripted engine: %s",
  async (scenario) => {
    const root = await mkdtemp(path.join(tmpdir(), "computer-save-"));
    const name = `ardurbot-${fleetComputerKey("space", "bot").slice(0, 40)}`;
    const labels = { "ardurbot.com/computer": name, "ardurbot.com/space": "space" };
    let exists = scenario !== "missing-container";
    let volume = scenario !== "missing-volume";
    let running = false;
    let files = [{ path: "keep.txt", content: new TextEncoder().encode("unsaved work") }];
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
                Config: { Image: "fixture", Labels: labels },
                State: { Running: running },
                HostConfig: { NetworkMode: "bridge" },
              },
            ]),
          );
        else if (args.includes("volume") && args.includes("ls"))
          stdout = Buffer.from(volume ? `${name}-home` : "");
        else if (args.includes("volume") && args.includes("inspect"))
          stdout = Buffer.from(JSON.stringify([{ Labels: labels }]));
        else if (args.includes("start")) running = scenario !== "stays-stopped";
        else if (args.includes("create") && args.includes("--name")) {
          exists = true;
          files = [];
        } else if (args.includes("create") && args.includes("volume")) volume = true;
        else if (args.includes("rm") && args.includes("volume")) volume = false;
        else if (args.includes("rm")) exists = false;
        else if (args.includes("stop")) running = false;
        else if (args.includes("exec")) {
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
        }
        return { code: 0, stdout, stderr: Buffer.alloc(0) };
      },
    );
    const source = new FleetDockerSandboxProvider(
      ComputerConnectionSettingsSchema.parse({
        engine: "docker",
        endpoint: "unix:///fixture/engine.sock",
        standardImage: "fixture",
      }),
      { run, start: vi.fn() } as FleetProcess,
    );
    const target = scenario === "move" ? new FakeSandboxProvider() : undefined;
    const row = {
      id: "computer",
      homeKey: "bot",
      kind: "remote-docker",
      connectionId: "engine",
      scope: "dedicated",
      state: "error",
      providerRef: name as string | null,
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
      } else {
        await expect(work).rejects.toMatchObject({
          reason:
            scenario === "unreachable"
              ? "engine-unreachable"
              : scenario === "stays-stopped"
                ? "source-not-running"
                : "source-missing",
        });
        expect(row.state).toBe("error");
        expect(row.homeRevision).toBe("old");
        expect(
          run.mock.calls.some(([, args]) => args.includes("rm") || args.includes("create")),
        ).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
