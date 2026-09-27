import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { expect, it } from "vitest";
import type { HermesLaunch, HermesLaunchSpec } from "./hermes-runtime.js";
import { HermesRuntime } from "./hermes-runtime.js";

const execute = promisify(execFile);
const image =
  "nousresearch/hermes-agent@sha256:c64666f62179b6cd7d2df3348a30907b383a82a8e0d2400083b8004e24615780";
const fixture = fileURLToPath(new URL("./fixtures/hermes-image-fixture.py", import.meta.url));
const evidence = "/Volumes/EXTENDED/ardur-measurements/hermes-m0";
const dockerEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock`,
};

interface LaneCapture {
  records: Array<{ kind: string; ms: number; hostMs: number; value: Record<string, unknown> }>;
  containerStartMs: number | null;
  handshakeMs: number | null;
  name: string;
}

function launchFor(captures: LaneCapture[], start: number): HermesLaunch {
  return async (spec: HermesLaunchSpec) => {
    const name = `ardur-hermes-m0-${randomUUID()}`;
    const data: LaneCapture = { records: [], containerStartMs: null, handshakeMs: null, name };
    captures.push(data);
    const staging = await mkdtemp(join(resolve(process.cwd(), "..", ".work"), "hermes-image-"));
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
    const child = spawn(
      "docker",
      [
        "run",
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
        "--env",
        `ARDUR_HERMES_PROVIDER_KEY=${spec.env.ARDUR_HERMES_PROVIDER_KEY}`,
        "--entrypoint",
        "/opt/hermes/.venv/bin/python",
        image,
        "/fixtures/hermes-image-fixture.py",
        "launch",
      ],
      { env: dockerEnv, stdio: "pipe" },
    );
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
      const running = await execute("docker", ["inspect", "--format", "{{.State.Running}}", name], {
        env: dockerEnv,
        timeout: 2_000,
      }).then(
        ({ stdout }) => stdout.trim() === "true",
        () => false,
      );
      if (running) {
        data.containerStartMs = Math.round(performance.now() - start);
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
      teardown: async () => {
        await execute("docker", ["stop", "--time", "1", name], {
          env: dockerEnv,
          timeout: 10_000,
        }).catch(() => undefined);
        await rm(staging, { recursive: true, force: true });
      },
    };
  };
}

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
    await adapter.abort(held.runId);
    await pending;
    const stopped = await execute("docker", ["inspect", captures[1]!.name], {
      env: dockerEnv,
      timeout: 10_000,
    }).then(
      () => false,
      () => true,
    );
    await writeFile(
      join(evidence, "cancel.json"),
      JSON.stringify(
        { stopped, providerCapturedBeforeAbort, events: heldEvents, container: captures[1]?.name },
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
    expect(stopped).toBe(true);
  }, 180_000);
}
