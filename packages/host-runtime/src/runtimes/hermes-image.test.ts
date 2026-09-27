import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { expect, it, vi } from "vitest";
import type { HermesLaunch, HermesLaunchSpec } from "./hermes-runtime.js";
import { HermesRuntime } from "./hermes-runtime.js";

const execute = promisify(execFile);
const image =
  "nousresearch/hermes-agent@sha256:c64666f62179b6cd7d2df3348a30907b383a82a8e0d2400083b8004e24615780";
const fixture = fileURLToPath(new URL("./fixtures/hermes-image-fixture.py", import.meta.url));
function evidenceDirectory() {
  // The lane runner sets ARDUR_HERMES_EVIDENCE_DIR; the repository carries no machine-specific path.
  return process.env.ARDUR_HERMES_EVIDENCE_DIR ?? tmpdir();
}

function dockerEnvironment(socketExists: (path: string) => boolean = existsSync) {
  const colimaSocket = join(homedir(), ".colima/default/docker.sock");
  const dockerHost =
    process.env.DOCKER_HOST !== undefined
      ? process.env.DOCKER_HOST
      : socketExists(colimaSocket) && !socketExists("/var/run/docker.sock")
        ? `unix://${colimaSocket}`
        : undefined;
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(dockerHost === undefined ? {} : { DOCKER_HOST: dockerHost }),
  };
}

function dockerProviderKey(providerKey: string) {
  return {
    args: ["--env", "ARDUR_HERMES_PROVIDER_KEY"],
    env: { ARDUR_HERMES_PROVIDER_KEY: providerKey },
  };
}

function missingDockerObject(error: unknown, kind: "image" | "container") {
  const reported = error as { stderr?: unknown; message?: unknown };
  const detail = `${String(reported.stderr ?? "")} ${String(reported.message ?? "")}`;
  return kind === "image"
    ? /No such (?:image|object)/i.test(detail)
    : /No such (?:container|object)/i.test(detail);
}

async function inspectContainerStopped(name: string, runDocker: typeof execute = execute) {
  try {
    await runDocker("docker", ["inspect", name], {
      env: dockerEnvironment(),
      timeout: 10_000,
    });
    return false;
  } catch (error) {
    if (missingDockerObject(error, "container")) return true;
    throw new Error("Hermes container stop could not be verified.", { cause: error });
  }
}

async function stagingDirectory(socketExists: (path: string) => boolean = existsSync) {
  // The default Colima VM only mounts HOME; other Docker endpoints can mount writable parents elsewhere.
  const parent = process.env.ARDUR_HERMES_STAGING_PARENT ?? process.cwd();
  const outsideHome = relative(homedir(), parent);
  const dockerHost = dockerEnvironment(socketExists).DOCKER_HOST;
  if (
    dockerHost?.startsWith(`unix://${join(homedir(), ".colima")}/`) &&
    dockerHost.endsWith("/docker.sock") &&
    (outsideHome === ".." ||
      outsideHome.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  )
    throw new Error("Hermes image staging must be below HOME.");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, ".hermes-image-"));
}

function assertFirstTurn(failure: string | null, events: AgentRuntimeEvent[]) {
  expect(failure).toBeNull();
  expect(events.at(-1)).toEqual({ type: "done" });
  expect(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
  ).toContain("completed");
}

it("fails image qualification when the first turn fails or lacks its answer", () => {
  expect(() => assertFirstTurn("failed", [{ type: "done" }])).toThrow();
  expect(() => assertFirstTurn(null, [])).toThrow();
  expect(() =>
    assertFirstTurn(null, [{ type: "text", text: "wrong" }, { type: "done" }]),
  ).toThrow();
});

it("uses portable image lane paths and the selected Docker endpoint", async () => {
  const previousEvidence = process.env.ARDUR_HERMES_EVIDENCE_DIR;
  const previousHost = process.env.DOCKER_HOST;
  const previousStaging = process.env.ARDUR_HERMES_STAGING_PARENT;
  const stagingParent = await mkdtemp(join(tmpdir(), ".hermes-staging-parent-"));
  let staging: string | undefined;
  try {
    process.env.ARDUR_HERMES_EVIDENCE_DIR = join(tmpdir(), "fixture-evidence");
    process.env.DOCKER_HOST = "unix:///fixture/docker.sock";
    process.env.ARDUR_HERMES_STAGING_PARENT = stagingParent;
    staging = await stagingDirectory();
    expect(evidenceDirectory()).toBe(join(tmpdir(), "fixture-evidence"));
    expect(dockerEnvironment().DOCKER_HOST).toBe("unix:///fixture/docker.sock");
    expect(dirname(staging)).toBe(stagingParent);
  } finally {
    if (previousEvidence === undefined) delete process.env.ARDUR_HERMES_EVIDENCE_DIR;
    else process.env.ARDUR_HERMES_EVIDENCE_DIR = previousEvidence;
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
    if (previousStaging === undefined) delete process.env.ARDUR_HERMES_STAGING_PARENT;
    else process.env.ARDUR_HERMES_STAGING_PARENT = previousStaging;
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(stagingParent, { recursive: true, force: true });
  }
});

it("uses the standard Docker endpoint unless only the Colima socket exists", () => {
  const previousHost = process.env.DOCKER_HOST;
  try {
    delete process.env.DOCKER_HOST;
    expect(dockerEnvironment(() => false).DOCKER_HOST).toBeUndefined();
    expect(
      dockerEnvironment((path) => path === join(homedir(), ".colima/default/docker.sock"))
        .DOCKER_HOST,
    ).toBe(`unix://${homedir()}/.colima/default/docker.sock`);
    expect(dockerEnvironment(() => true).DOCKER_HOST).toBeUndefined();
  } finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = previousHost;
  }
});

const temporaryParentIsBelowHome = (() => {
  const path = relative(homedir(), tmpdir());
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
})();

it.skipIf(temporaryParentIsBelowHome)(
  "allows staging outside HOME with the standard or an explicit non-Colima endpoint (skipped when the temporary directory is below HOME)",
  async () => {
    const previousHost = process.env.DOCKER_HOST;
    const previousStaging = process.env.ARDUR_HERMES_STAGING_PARENT;
    const stagingParent = await mkdtemp(join(tmpdir(), ".hermes-staging-parent-"));
    const created: string[] = [];
    try {
      process.env.ARDUR_HERMES_STAGING_PARENT = stagingParent;
      delete process.env.DOCKER_HOST;
      expect(dockerEnvironment(() => false).DOCKER_HOST).toBeUndefined();
      created.push(await stagingDirectory(() => false));
      process.env.DOCKER_HOST = "unix:///fixture/docker.sock";
      expect(dockerEnvironment(() => false).DOCKER_HOST).toBe("unix:///fixture/docker.sock");
      created.push(await stagingDirectory(() => false));
      expect(created.every((path) => dirname(path) === stagingParent)).toBe(true);
    } finally {
      if (previousHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousHost;
      if (previousStaging === undefined) delete process.env.ARDUR_HERMES_STAGING_PARENT;
      else process.env.ARDUR_HERMES_STAGING_PARENT = previousStaging;
      for (const path of created) await rm(path, { recursive: true, force: true });
      await rm(stagingParent, { recursive: true, force: true });
    }
  },
);

it.skipIf(temporaryParentIsBelowHome)(
  "rejects Colima staging outside HOME (skipped when the temporary directory is below HOME)",
  async () => {
    const previousHost = process.env.DOCKER_HOST;
    const previousStaging = process.env.ARDUR_HERMES_STAGING_PARENT;
    const stagingParent = await mkdtemp(join(tmpdir(), ".hermes-staging-parent-"));
    try {
      process.env.DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;
      process.env.ARDUR_HERMES_STAGING_PARENT = stagingParent;
      await expect(stagingDirectory()).rejects.toThrow("Hermes image staging must be below HOME.");
    } finally {
      if (previousHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousHost;
      if (previousStaging === undefined) delete process.env.ARDUR_HERMES_STAGING_PARENT;
      else process.env.ARDUR_HERMES_STAGING_PARENT = previousStaging;
      await rm(stagingParent, { recursive: true, force: true });
    }
  },
);

it.skipIf(!temporaryParentIsBelowHome)(
  "accepts Colima staging below HOME (skipped when the temporary directory is outside HOME)",
  async () => {
    const previousHost = process.env.DOCKER_HOST;
    const previousStaging = process.env.ARDUR_HERMES_STAGING_PARENT;
    const stagingParent = await mkdtemp(join(tmpdir(), ".hermes-staging-parent-"));
    let staging: string | undefined;
    try {
      process.env.DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;
      process.env.ARDUR_HERMES_STAGING_PARENT = stagingParent;
      staging = await stagingDirectory();
      expect(dirname(staging)).toBe(stagingParent);
    } finally {
      if (previousHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousHost;
      if (previousStaging === undefined) delete process.env.ARDUR_HERMES_STAGING_PARENT;
      else process.env.ARDUR_HERMES_STAGING_PARENT = previousStaging;
      if (staging) await rm(staging, { recursive: true, force: true });
      await rm(stagingParent, { recursive: true, force: true });
    }
  },
);

it("keeps the fake provider key out of Docker argv", () => {
  const key = "fixture-provider-key-123";
  const option = dockerProviderKey(key);
  expect(option.args.join(" ")).not.toContain(key);
  expect(option.env.ARDUR_HERMES_PROVIDER_KEY).toBe(key);
});

interface LaneCapture {
  records: Array<{ kind: string; ms: number; hostMs: number; value: Record<string, unknown> }>;
  containerStartMs: number | null;
  handshakeMs: number | null;
  name: string;
  argvHasKey: boolean;
  inspectHasKey: boolean;
  stopFailure: string | null;
}

function launchFor(
  captures: LaneCapture[],
  start: number,
  dependencies: {
    execute: typeof execute;
    spawn: typeof spawn;
    onStaging?: (path: string) => void;
  } = {
    execute,
    spawn,
  },
): HermesLaunch {
  return async (spec: HermesLaunchSpec) => {
    const providerKey = spec.env.ARDUR_HERMES_PROVIDER_KEY;
    if (!providerKey) throw new Error("The image lane needs its fake provider key.");
    const keyOption = dockerProviderKey(providerKey);
    const name = `ardur-hermes-m0-${randomUUID()}`;
    const data: LaneCapture = {
      records: [],
      containerStartMs: null,
      handshakeMs: null,
      name,
      argvHasKey: false,
      inspectHasKey: false,
      stopFailure: null,
    };
    captures.push(data);
    try {
      await dependencies.execute("docker", ["image", "inspect", image], {
        env: dockerEnvironment(),
        timeout: 10_000,
      });
    } catch (error) {
      throw new Error(
        missingDockerObject(error, "image")
          ? "Pinned Hermes image is absent locally; no download was attempted."
          : "Pinned Hermes image inspection failed; the cached image could not be verified.",
        { cause: error },
      );
    }
    const staging = await stagingDirectory();
    dependencies.onStaging?.(staging);
    const configCopy = join(staging, "image-config.yaml");
    const soulCopy = join(staging, "image-SOUL.md");
    await copyFile(join(spec.env.HERMES_HOME!, "config.yaml"), configCopy);
    await copyFile(join(spec.env.HERMES_HOME!, "SOUL.md"), soulCopy);
    await chmod(configCopy, 0o644);
    await chmod(soulCopy, 0o644);
    const mounts = [
      [fixture, "/fixtures/hermes-image-fixture.py"],
      [configCopy, "/fixtures/config.yaml"],
      [soulCopy, "/fixtures/SOUL.md"],
    ].flatMap(([src, dst]) => ["--mount", `type=bind,src=${src},dst=${dst},readonly`]);
    const child = dependencies.spawn(
      "docker",
      [
        "run",
        "--pull=never",
        "-i",
        "--rm",
        "--network",
        "none",
        "--name",
        name,
        "--label",
        "ardur.hermes-m0=1",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
        "--tmpfs",
        "/work:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=700",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "10001:10001",
        "--memory",
        "1024m",
        "--memory-swap",
        "1024m",
        "--pids-limit",
        "128",
        "--log-driver",
        "none",
        ...mounts,
        ...keyOption.args,
        "--entrypoint",
        "/opt/hermes/.venv/bin/python",
        image,
        "/fixtures/hermes-image-fixture.py",
        "launch",
      ],
      {
        env: {
          ...dockerEnvironment(),
          ...keyOption.env,
        },
        stdio: "pipe",
      },
    );
    const teardown = async () => {
      let stopError: Error | undefined;
      try {
        await dependencies.execute("docker", ["stop", "--time", "1", name], {
          env: dockerEnvironment(),
          timeout: 10_000,
        });
      } catch (error) {
        if (!missingDockerObject(error, "container")) {
          data.stopFailure = "Hermes container cleanup could not be verified.";
          stopError = new Error(data.stopFailure, { cause: error });
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      if (stopError) throw stopError;
    };
    try {
      data.argvHasKey = child.spawnargs.some((arg) => arg.includes(providerKey));
      child.stdout.once("data", () => {
        data.handshakeMs = Math.round(performance.now() - start);
      });
      let line = "";
      child.stderr.on("data", (chunk: Buffer) => {
        line += chunk.toString("utf8");
        if (line.length > 16 * 1024 * 1024) line = "";
        let end = line.indexOf("\n");
        while (end >= 0) {
          const item = line.slice(0, end);
          line = line.slice(end + 1);
          if (item.startsWith("ARDUR_EVIDENCE:")) {
            try {
              data.records.push({
                ...JSON.parse(item.slice("ARDUR_EVIDENCE:".length)),
                hostMs: Math.round(performance.now() - start),
              });
            } catch {
              // An incomplete evidence record is not counted.
            }
          }
          end = line.indexOf("\n");
        }
      });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const running = await dependencies
          .execute("docker", ["inspect", "--format", "{{.State.Running}}", name], {
            env: dockerEnvironment(),
            timeout: 2_000,
          })
          .then(
            ({ stdout }) => stdout.trim() === "true",
            (error) => {
              if (missingDockerObject(error, "container")) return false;
              throw error;
            },
          );
        if (running) {
          data.containerStartMs = Math.round(performance.now() - start);
          const inspected = await dependencies.execute(
            "docker",
            ["inspect", "--format", "{{json .Config.Env}}", name],
            {
              env: dockerEnvironment(),
              timeout: 2_000,
            },
          );
          data.inspectHasKey = (JSON.parse(inspected.stdout) as string[]).includes(
            `ARDUR_HERMES_PROVIDER_KEY=${providerKey}`,
          );
          break;
        }
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        child,
        sessionCwd: "/work",
        mcpConfig: {
          command: "/opt/hermes/.venv/bin/python",
          args: ["/fixtures/hermes-image-fixture.py", "mcp"],
          env: {},
        },
        teardown,
      };
    } catch (error) {
      await teardown();
      throw error;
    }
  };
}

it("rejects a missing cached image before starting Docker", async () => {
  const parent = await mkdtemp(join(process.cwd(), ".hermes-launch-test-"));
  const home = join(parent, "home");
  await mkdir(home);
  await writeFile(join(home, "config.yaml"), "{}\n");
  await writeFile(join(home, "SOUL.md"), "fixture\n");
  const previousStaging = process.env.ARDUR_HERMES_STAGING_PARENT;
  process.env.ARDUR_HERMES_STAGING_PARENT = parent;
  const runDocker = vi.fn(async () => {
    throw Object.assign(new Error("image absent"), { stderr: "No such image" });
  });
  const startDocker = vi.fn();
  try {
    await expect(
      launchFor([], performance.now(), {
        execute: runDocker as unknown as typeof execute,
        spawn: startDocker as unknown as typeof spawn,
      })({
        command: "fixture",
        args: [],
        cwd: parent,
        env: { HERMES_HOME: home, ARDUR_HERMES_PROVIDER_KEY: "fixture-provider-key" },
      }),
    ).rejects.toThrow("Pinned Hermes image is absent locally; no download was attempted.");
    expect(runDocker).toHaveBeenCalledWith(
      "docker",
      ["image", "inspect", image],
      expect.anything(),
    );
    expect(startDocker).not.toHaveBeenCalled();
  } finally {
    if (previousStaging === undefined) delete process.env.ARDUR_HERMES_STAGING_PARENT;
    else process.env.ARDUR_HERMES_STAGING_PARENT = previousStaging;
    await rm(parent, { recursive: true, force: true });
  }
});

it("records a Docker stop failure and fails qualification", async () => {
  const parent = await mkdtemp(join(process.cwd(), ".hermes-launch-test-"));
  const home = join(parent, "home");
  await mkdir(home);
  await writeFile(join(home, "config.yaml"), "{}\n");
  await writeFile(join(home, "SOUL.md"), "fixture\n");
  const previousStaging = process.env.ARDUR_HERMES_STAGING_PARENT;
  process.env.ARDUR_HERMES_STAGING_PARENT = parent;
  const runDocker = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === "inspect") throw new Error("inspection unavailable");
    if (args[0] === "stop") throw new Error("daemon unavailable");
    return { stdout: "[]", stderr: "" };
  });
  const child = {
    spawnargs: [],
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: 1,
  } as unknown as ReturnType<typeof spawn>;
  const startDocker = vi.fn((_command: string, _args: string[]) => child);
  const captures: LaneCapture[] = [];
  try {
    await expect(
      launchFor(captures, performance.now(), {
        execute: runDocker as unknown as typeof execute,
        spawn: startDocker as unknown as typeof spawn,
      })({
        command: "fixture",
        args: [],
        cwd: parent,
        env: { HERMES_HOME: home, ARDUR_HERMES_PROVIDER_KEY: "fixture-provider-key" },
      }),
    ).rejects.toThrow("Hermes container cleanup could not be verified.");
    expect(captures[0]?.stopFailure).toBe("Hermes container cleanup could not be verified.");
    expect(startDocker.mock.calls[0]?.[1]).toContain("--pull=never");
  } finally {
    if (previousStaging === undefined) delete process.env.ARDUR_HERMES_STAGING_PARENT;
    else process.env.ARDUR_HERMES_STAGING_PARENT = previousStaging;
    await rm(parent, { recursive: true, force: true });
  }
});

it("counts only Docker's missing-container response as stopped", async () => {
  for (const detail of ["No such container: fixture", "No such object: fixture"]) {
    const missing = vi.fn(async () => {
      throw Object.assign(new Error("inspection failed"), { stderr: detail });
    });
    expect(await inspectContainerStopped("fixture", missing as unknown as typeof execute)).toBe(
      true,
    );
  }
  for (const detail of ["Cannot connect to Docker daemon", "No such image: fixture"]) {
    const daemon = vi.fn(async () => {
      throw Object.assign(new Error("inspection failed"), { stderr: detail });
    });
    await expect(
      inspectContainerStopped("fixture", daemon as unknown as typeof execute),
    ).rejects.toThrow("Hermes container stop could not be verified.");
  }
});

it("stops its container and removes staging when inspection fails after spawn", async () => {
  const parent = await mkdtemp(join(process.cwd(), ".hermes-launch-test-"));
  const home = join(parent, "home");
  await mkdir(home);
  await writeFile(join(home, "config.yaml"), "{}\n");
  await writeFile(join(home, "SOUL.md"), "fixture\n");
  const previousStaging = process.env.ARDUR_HERMES_STAGING_PARENT;
  process.env.ARDUR_HERMES_STAGING_PARENT = parent;
  let staging: string | undefined;
  const inspectionError = new Error("fixture inspect failed");
  let inspections = 0;
  const runDocker = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === "inspect") {
      inspections++;
      if (inspections === 2) throw inspectionError;
      return { stdout: "true\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  const child = {
    spawnargs: [],
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
  } as unknown as ReturnType<typeof spawn>;
  const captures: LaneCapture[] = [];
  try {
    await expect(
      launchFor(captures, performance.now(), {
        execute: runDocker as unknown as typeof execute,
        spawn: (() => child) as typeof spawn,
        onStaging: (path) => {
          staging = path;
        },
      })({
        command: "fixture",
        args: [],
        cwd: parent,
        env: { HERMES_HOME: home, ARDUR_HERMES_PROVIDER_KEY: "fixture-provider-key" },
      }),
    ).rejects.toBe(inspectionError);
    expect(runDocker).toHaveBeenCalledWith(
      "docker",
      ["stop", "--time", "1", captures[0]!.name],
      expect.anything(),
    );
    expect(staging).toBeDefined();
    expect(existsSync(staging!)).toBe(false);
  } finally {
    if (previousStaging === undefined) delete process.env.ARDUR_HERMES_STAGING_PARENT;
    else process.env.ARDUR_HERMES_STAGING_PARENT = previousStaging;
    await rm(parent, { recursive: true, force: true });
  }
});

function request(prompt: string): AgentRunRequest {
  return {
    botId: "bot-fixture",
    threadId: "thread-fixture",
    runId: randomUUID(),
    prompt,
    instructions: "Use the supplied tool when it is available.",
    history: [
      { role: "user", content: "Earlier request" },
      { role: "assistant", content: "Earlier response" },
    ],
    tools: [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }],
    model: {
      provider: "custom:ardur",
      id: "fixture-model",
      apiKey: "fixture-provider-key-123",
      baseUrl: "http://127.0.0.1:7766/v1",
      contextWindow: 65_536,
      reasoning: true,
      acceptsImages: true,
      thinkingLevel: "high",
    },
    currentTurnImages: [
      {
        name: "pixel.png",
        mimeType: "image/png",
        data: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
          "base64",
        ),
      },
    ],
    executeTool: async () => ({ text: "echoed" }),
  };
}

if (process.env.ARDUR_HERMES_IMAGE_LANE !== "1") {
  it.skip("the pinned Hermes image lane is opt-in: set ARDUR_HERMES_IMAGE_LANE=1 on a machine with the approved image", () => {});
} else {
  it("qualifies the pinned ACP image and records the provider catalog", async () => {
    const evidence = evidenceDirectory();
    await mkdir(evidence, { recursive: true });
    const captures: LaneCapture[] = [];
    const start = performance.now();
    const adapter = new HermesRuntime({
      command: "/opt/hermes/.venv/bin/hermes-acp",
      launch: launchFor(captures, start),
    });
    const first = request("Call the supplied echo tool, then answer.");
    const events: AgentRuntimeEvent[] = [];
    let sessionNewMs: number | null = null;
    let firstTextMs: number | null = null;
    first.onRuntimeInfo = async () => {
      sessionNewMs = Math.round(performance.now() - start);
    };
    let failure: string | null = null;
    try {
      for await (const event of adapter.run(first)) {
        events.push(event);
        if (event.type === "text" && firstTextMs === null)
          firstTextMs = Math.round(performance.now() - start);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : "The image run failed.";
    }
    const provider = captures[0]?.records.filter((record) => record.kind === "provider") ?? [];
    const mcp = captures[0]?.records.filter((record) => record.kind === "mcp") ?? [];
    const requests = provider.map((record) => record.value.request);
    const firstRequest = requests[0] as Record<string, unknown> | undefined;
    const tools = Array.isArray(firstRequest?.tools)
      ? firstRequest.tools.map((tool) => (tool as { function?: { name?: string } }).function?.name)
      : [];
    const transcript = {
      failure,
      events,
      container: captures[0]?.name,
      toolNames: tools,
      mcp,
      keyPresentInContainer: captures[0]?.inspectHasKey,
      keyAbsentFromDockerArgv: !captures[0]?.argvHasKey,
      stopFailure: captures[0]?.stopFailure,
    };
    const timings = {
      containerStartMs: captures[0]?.containerStartMs ?? null,
      handshakeMs: captures[0]?.handshakeMs ?? null,
      sessionNewMs,
      toolDiscoveryMs:
        mcp.find((record) => record.value.event === "tool-discovery")?.hostMs ?? null,
      firstTextMs,
    };
    await writeFile(join(evidence, "provider-requests.json"), JSON.stringify(requests, null, 2));
    await writeFile(join(evidence, "event-transcript.json"), JSON.stringify(transcript, null, 2));
    await writeFile(join(evidence, "timings.json"), JSON.stringify(timings, null, 2));
    assertFirstTurn(failure, events);
    expect(captures[0]?.argvHasKey).toBe(false);
    expect(captures[0]?.inspectHasKey).toBe(true);

    const held = request("hold");
    const heldEvents: AgentRuntimeEvent[] = [];
    const pending = (async () => {
      for await (const event of adapter.run(held)) heldEvents.push(event);
    })();
    const until = Date.now() + 20_000;
    while (Date.now() < until && !captures[1]?.records.some((record) => record.kind === "provider"))
      await new Promise((resolve) => setTimeout(resolve, 50));
    const providerCapturedBeforeAbort =
      captures[1]?.records.some((record) => record.kind === "provider") ?? false;
    let abortFailure: string | null = null;
    try {
      await adapter.abort(held.runId);
      await pending;
    } catch {
      abortFailure = "Hermes cancellation or cleanup failed.";
    }
    let stopped = false;
    let inspectionFailure: string | null = null;
    try {
      stopped = await inspectContainerStopped(captures[1]!.name);
    } catch {
      inspectionFailure = "Hermes container stop could not be verified.";
    }
    await writeFile(
      join(evidence, "cancel.json"),
      JSON.stringify(
        {
          stopped,
          providerCapturedBeforeAbort,
          events: heldEvents,
          container: captures[1]?.name,
          stopFailure: captures[1]?.stopFailure,
          abortFailure,
          inspectionFailure,
        },
        null,
        2,
      ),
    );
    expect(provider.length).toBeGreaterThan(0);
    expect(firstRequest?.model).toBe("fixture-model");
    expect(tools).toEqual([
      "delegate_task",
      "execute_code",
      "mcp__ardur__fixture_echo",
      "patch",
      "process",
      "read_file",
      "search_files",
      "session_search",
      "skill_manage",
      "skill_view",
      "skills_list",
      "terminal",
      "todo",
      "vision_analyze",
      "web_extract",
      "web_search",
      "write_file",
    ]);
    expect(firstRequest?.reasoning_effort).toBeUndefined();
    expect(firstRequest?.reasoning).toBeUndefined();
    const messages = firstRequest?.messages as Array<{ role: string; content: unknown }>;
    const system = messages.find((message) => message.role === "system");
    expect(JSON.stringify(system?.content)).toContain("Use the supplied tool");
    expect(JSON.stringify(system?.content)).toContain("Earlier request");
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image_url",
          image_url: expect.objectContaining({
            url: expect.stringMatching(/^data:image\/png;base64,/),
          }),
        }),
      ]),
    );
    expect(mcp.some((record) => record.value.event === "tool-call")).toBe(true);
    expect(providerCapturedBeforeAbort).toBe(true);
    expect(heldEvents.some((event) => event.type === "done")).toBe(false);
    expect(captures[0]?.stopFailure).toBeNull();
    expect(captures[1]?.stopFailure).toBeNull();
    expect(abortFailure).toBeNull();
    expect(inspectionFailure).toBeNull();
    expect(stopped).toBe(true);
  }, 180_000);
}
