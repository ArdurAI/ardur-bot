import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext, AgentRunRequest } from "@ardurbot/adapter-kit";
import { buildHermesRuntime } from "@ardurbot/host-runtime/runtimes/hermes-install";
import type { HermesRuntime } from "@ardurbot/host-runtime/runtimes/hermes-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import profileFixture from "../../../host-runtime/python/tests/valid_profile.json" with {
  type: "json",
};
import type { HermesProviderBroker } from "../hermes-provider-broker.js";
import { advertisedHostTools, buildHostTurn } from "../host-turn.js";
import { LocalHermesRuntime } from "./local-hermes-runtime.js";

vi.mock("../../../host-runtime/python/hermes_sources.json", () => ({ default: {} }));

vi.mock("@ardurbot/host-runtime/runtimes/hermes-install", async (original) => {
  const mod = await original<typeof import("@ardurbot/host-runtime/runtimes/hermes-install")>();
  return { ...mod, buildHermesRuntime: vi.fn(mod.buildHermesRuntime) };
});

vi.mock("@ardurbot/core/node/runtime-config-hash", async (original) => ({
  ...(await original<object>()),
  validateHermesExecutionEnvelope: (x: any) => profileFixture,
}));

describe("LocalHermesRuntime", () => {
  let root: string;
  let installDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "local-hermes-test-"));
    installDir = join(root, "install");
    vi.stubEnv("ARDUR_HERMES_INSTALL", installDir);
    vi.stubEnv("ARDURBOT_APP_DATA", root);
    vi.stubEnv("DATA_DIR", join(root, "data"));
    vi.stubEnv("ARDUR_HERMES_PROVIDER_KEY", "fixture-provider-key-123");
    await mkdir(join(installDir, ".venv", "bin"), { recursive: true });
    await writeFile(join(installDir, "pyproject.toml"), "hermes-agent");
    await writeFile(join(installDir, "uv.lock"), "hermes-agent");
    const fakeAcp = fileURLToPath(
      new URL("../../../host-runtime/src/runtimes/fixtures/fake-acp.mjs", import.meta.url),
    );
    await writeFile(
      join(installDir, ".venv", "bin", "python"),
      `#!${process.execPath}\nconst fs = require("fs");\ntry {\n  const scenario = fs.existsSync(${JSON.stringify(require("path").join(root, "scenario.txt"))}) ? fs.readFileSync(${JSON.stringify(require("path").join(root, "scenario.txt"))}, "utf8") : "text";\n  process.argv.splice(2, process.argv.length - 2, scenario);\n  if (process.env.ARDUR_HERMES_EXPECTED_HASH && scenario !== "profile-ack" && scenario !== "profile-stale") fs.writeFileSync(require("path").join(process.env.HERMES_HOME, "runtime-ack.json"), JSON.stringify({ profile: "hermes-ardur-v2", configurationHash: process.env.ARDUR_HERMES_EXPECTED_HASH, sessionId: "fixture-" + process.pid }), { mode: 0o600 });\n  if (scenario === "custom-tool-error") { const sessionId = "fixture-" + process.pid; let promptId = null; const readline = require("readline"); const rl = readline.createInterface({ input: process.stdin }); rl.on("line", (line) => { const msg = JSON.parse(line); if (msg.method === "initialize") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n"); } else if (msg.method === "session/new") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId } }) + "\\n"); } else if (msg.method === "session/prompt") { promptId = msg.id; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Provider request failed with key " + process.env.ARDUR_HERMES_PROVIDER_KEY } } } }) + "\\n"); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }) + "\\n"); } else if (msg.id) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n"); } }); return; }\nimport(${JSON.stringify(fakeAcp)}).then(() => setInterval(() => {}, 1000)).catch(e => { process.exit(1); });\n} catch (e) { process.exit(1); }\n`,
    );
    await import("node:fs/promises").then((fs) =>
      fs.chmod(join(installDir, ".venv", "bin", "python"), 0o755),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
    return {
      botId: "bot-fixture",
      threadId: "thread-fixture",
      runId: crypto.randomUUID(),
      prompt: "Hello",
      instructions: "Use the provided tools only.",
      history: [],
      tools: "none",
      model: {
        provider: "custom:ardur",
        id: "fixture-model",
        baseUrl: "http://127.0.0.1:7777/v1",
        apiKey: "fixture-provider-key-123",
        thinkingLevel: "high",
        contextWindow: 32768,
        maxTokens: 1024,
        reasoning: true,
        acceptsImages: false,
        runtimePin: {
          runtimeKind: "hermes",
          credentialId: "fixture-cred",
          provider: "openai-compatible",
          modelId: "fixture-model",
          effort: "high",
          revision: 1,
          runtimeConfig: profileFixture.runtimeConfig as any,
          runtimeConfigHash: profileFixture.runtimeConfigHash,
          effectiveRuntimeConfig: profileFixture.effectiveRuntimeConfig as any,
          effectiveRuntimeConfigHash: profileFixture.effectiveRuntimeConfigHash,
        },
      },
      ...overrides,
    };
  }

  async function collect(iterator: AsyncIterable<any>) {
    const result = [];
    for await (const x of iterator) result.push(x);
    return result;
  }

  it("fails if the broker is missing", async () => {
    const runtime = new LocalHermesRuntime();
    await expect(collect(runtime.run(request()))).rejects.toThrow(
      "Hermes needs a provider broker.",
    );
  });

  it("refuses if the install is missing, without opening a broker session", async () => {
    vi.stubEnv("ARDUR_HERMES_INSTALL", join(root, "missing"));
    const brokerForTurn = vi.fn().mockResolvedValue({
      broker: { grant: { id: "123", token: "token", expiresAt: 0 }, revoke: vi.fn() },
      scope: {},
    });
    const runtime = new LocalHermesRuntime(brokerForTurn);
    await expect(collect(runtime.run(request()))).rejects.toThrow(
      "Pinned Hermes install failed its safety check.",
    );
    expect(brokerForTurn).not.toHaveBeenCalled();
  });

  it("refuses provider and tool callbacks until the configuration is acknowledged", async () => {
    const token = "a".repeat(43);
    const open = vi.fn(
      async () =>
        new Response('{"model":"fixture-model"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    const broker = {
      grant: { id: crypto.randomUUID(), token, expiresAt: Date.now() + 60_000 },
      revoke: vi.fn(),
      open,
    };
    const executeTool = vi.fn(async () => ({ ok: true }));
    const onToolCompleted = vi.fn(async () => {});
    vi.mocked(buildHermesRuntime).mockImplementationOnce(async (options) => {
      const providerCall = (baseUrl: string) =>
        fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "fixture-model",
            messages: [{ role: "user", content: "hi" }],
          }),
        });
      return {
        abort: async () => {},
        fail: async () => {},
        run: async function* (req: AgentRunRequest) {
          await expect(req.executeTool?.("fixture_echo", {}, "run:early")).rejects.toThrow(
            "Hermes configuration is not acknowledged.",
          );
          await expect(
            req.onToolCompleted?.({
              name: "fixture_echo",
              executionId: "run:early",
              durationMs: 1,
            }),
          ).rejects.toThrow("Hermes configuration is not acknowledged.");
          const refused = await providerCall(req.model.baseUrl!);
          expect(refused.status).toBe(502);
          expect(open).not.toHaveBeenCalled();
          options.onProfileAcknowledged();
          await expect(req.executeTool?.("fixture_echo", {}, "run:late")).resolves.toEqual({
            ok: true,
          });
          const admitted = await providerCall(req.model.baseUrl!);
          expect(admitted.status).toBe(200);
          expect(open).toHaveBeenCalledOnce();
          yield { type: "done" };
        },
      } as unknown as HermesRuntime;
    });
    const req = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }],
      executeTool,
      onToolCompleted,
    });
    const runtime = new LocalHermesRuntime(async () => ({
      broker: broker as unknown as HermesProviderBroker,
      scope: {} as never,
    }));
    const events = await collect(runtime.run(req));
    expect(events).toContainEqual({ type: "done" });
    expect(broker.revoke).toHaveBeenCalled();
  });

  it("gates nothing when the request carries no execution envelope", async () => {
    const token = "b".repeat(43);
    const open = vi.fn(
      async () =>
        new Response('{"model":"fixture-model"}', {
          headers: { "content-type": "application/json" },
        }),
    );
    const broker = {
      grant: { id: crypto.randomUUID(), token, expiresAt: Date.now() + 60_000 },
      revoke: vi.fn(),
      open,
    };
    const executeTool = vi.fn(async () => ({ ok: true }));
    vi.mocked(buildHermesRuntime).mockImplementationOnce(async () => {
      return {
        abort: async () => {},
        fail: async () => {},
        run: async function* (req: AgentRunRequest) {
          // No acknowledgement ever fires for a request without an envelope.
          await expect(req.executeTool?.("fixture_echo", {}, "run:any")).resolves.toEqual({
            ok: true,
          });
          const admitted = await fetch(`${req.model.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: "fixture-model",
              messages: [{ role: "user", content: "hi" }],
            }),
          });
          expect(admitted.status).toBe(200);
          expect(open).toHaveBeenCalledOnce();
          yield { type: "done" };
        },
      } as unknown as HermesRuntime;
    });
    const req = request({
      tools: [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }],
      executeTool,
    });
    req.model.runtimePin = {
      runtimeKind: "hermes",
      credentialId: "fixture-cred",
      provider: "openai-compatible",
      modelId: "fixture-model",
      effort: "high",
      revision: 1,
    };
    const runtime = new LocalHermesRuntime(async () => ({
      broker: broker as unknown as HermesProviderBroker,
      scope: {} as never,
    }));
    const events = await collect(runtime.run(req));
    expect(events).toContainEqual({ type: "done" });
    expect(broker.revoke).toHaveBeenCalled();
  });

  it("gives Hermes the same turn as the bridge, minus the real credential", async () => {
    const grant = {
      id: crypto.randomUUID(),
      token: "grant-token-abc",
      expiresAt: Date.now() + 60_000,
    };
    const broker = { grant, revoke: vi.fn() };
    let captured: AgentRunRequest | undefined;
    vi.mocked(buildHermesRuntime).mockImplementationOnce(async () => {
      return {
        abort: async () => {},
        fail: async () => {},
        run: (req: AgentRunRequest) => {
          captured = req;
          return (async function* () {
            yield { type: "done" };
          })();
        },
      } as unknown as HermesRuntime;
    });
    const req = request({
      tools: [
        {
          name: "fixture_echo",
          description: "Echo",
          inputSchema: { type: "object" },
          route: { connectorId: "connector", toolName: "echo" },
        },
      ],
    });
    req.model.apiKey = "sentinel-real-key-321";
    req.model.oauth = { credential: { accessToken: "sentinel-oauth-token" } } as never;
    const runtime = new LocalHermesRuntime(async () => ({
      broker: broker as unknown as HermesProviderBroker,
      scope: {} as never,
    }));
    const events = await collect(runtime.run(req));
    expect(events).toContainEqual({ type: "done" });

    const expected = buildHostTurn({
      kind: "hermes",
      request: req,
      executionEnvelope: profileFixture as never,
    });
    // The local turn matches the bridge turn apart from the relay endpoint and grant token.
    expect(captured!.tools).toEqual(expected.tools);
    expect(captured!.tools).toEqual(advertisedHostTools(req.tools));
    expect(JSON.stringify(captured!.tools)).not.toContain("connectorId");
    const { baseUrl, apiKey, ...localModel } = captured!.model;
    expect(localModel).toEqual(expected.model);
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(apiKey).toBe(grant.token);
    expect("oauth" in captured!.model).toBe(false);
    expect(JSON.stringify(captured)).not.toContain("sentinel-real-key");
    expect(JSON.stringify(captured)).not.toContain("sentinel-oauth-token");
    expect(broker.revoke).toHaveBeenCalled();
  });

  function grantBroker() {
    const token = "a".repeat(43);
    const open = vi.fn(
      async () =>
        new Response('{"id":"fixture","choices":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const broker = {
      grant: { id: crypto.randomUUID(), token, expiresAt: Date.now() + 60_000 },
      revoke: vi.fn(),
      open,
    };
    return { token, open, broker };
  }

  async function runRelay(broker: {
    grant: { id: string; token: string; expiresAt: number };
    revoke: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
  }) {
    const runtime = new LocalHermesRuntime(
      vi.fn().mockResolvedValue({
        broker,
        scope: {},
      }),
    );
    const req = request();
    await writeFile(join(root, "scenario.txt"), "relay");
    req.prompt = "relay";
    const context: any = {
      agentInstall: { hostRoot: "something", version: "1" },
      mcpConfig: { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], env: {} },
    };
    const result = await collect(runtime.run(req, context));
    const report = JSON.parse(await readFile(join(installDir, "relay-report.json"), "utf8")) as {
      status: number;
      relayUrl: string;
    };
    return { result, report };
  }

  it("completes a local runtime success turn and routes a provider call through the relay", async () => {
    const { open, broker } = grantBroker();
    const { result, report } = await runRelay(broker);

    expect(result).toContainEqual(expect.objectContaining({ type: "done" }));
    expect(report.status).toBe(200);
    expect(report.relayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      path: "/v1/chat/completions",
      body: {
        model: "fixture-model",
        messages: [{ role: "user", content: "relay-probe" }],
      },
    });
    expect(broker.revoke).toHaveBeenCalled();
  });

  it("keeps the real provider key off the spawned Hermes process", async () => {
    const token = "b".repeat(43);
    const broker = {
      grant: { id: "123", token, expiresAt: Date.now() + 60_000 },
      revoke: vi.fn(),
    };
    const runtime = new LocalHermesRuntime(
      vi.fn().mockResolvedValue({
        broker,
        scope: { executeTool: vi.fn() },
      }),
    );

    vi.stubEnv("ARDUR_PARENT_SECRET", "sentinel-parent");
    const req = request();
    req.model = {
      ...req.model,
      apiKey: "sentinel-real-provider-key",
      baseUrl: "http://127.0.0.1:9/sentinel-real-base",
    };
    await writeFile(join(root, "scenario.txt"), "inspect");
    req.prompt = "inspect";
    const context: any = {
      agentInstall: { hostRoot: "something", version: "1" },
      mcpConfig: { command: "node", args: ["-e", "setInterval(() => {}, 1000)"], env: {} },
    };

    const result = await collect(runtime.run(req, context));
    expect(result).toContainEqual(expect.objectContaining({ type: "done" }));
    const report = JSON.parse(await readFile(join(installDir, "spawn-report.json"), "utf8")) as {
      providerKey: string;
      baseUrl: string;
      env: Record<string, string>;
      config: unknown;
      homeMatches: boolean;
      cwdMatches: boolean;
      parentSecretAbsent: boolean;
    };
    const dumped = JSON.stringify({ env: report.env, config: report.config });
    expect(dumped).not.toContain("sentinel-real-provider-key");
    expect(dumped).not.toContain("sentinel-real-base");
    expect(dumped).not.toContain("sentinel-parent");
    expect(report.providerKey).toBe(token);
    expect(report.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(report.homeMatches).toBe(true);
    expect(report.cwdMatches).toBe(true);
    expect(report.parentSecretAbsent).toBe(true);
  });

  it("handles provider failure properly as tool failed without exposing key", async () => {
    const executeTool = vi.fn(async () => {
      throw new Error("Provider request failed with key fixture-provider-key-123");
    });
    const broker = { grant: { id: "123", token: "token", expiresAt: 0 }, revoke: vi.fn() };
    const runtime = new LocalHermesRuntime(
      vi.fn().mockResolvedValue({
        broker,
        scope: { executeTool },
      }),
    );

    const req = request();
    req.tools = [{ name: "fixture_echo", description: "Echo", inputSchema: { type: "object" } }];
    await import("node:fs/promises").then((m) =>
      m.writeFile(join(root, "scenario.txt"), "custom-tool-error"),
    );
    req.prompt = "custom-tool-error";
    const context: any = { agentInstall: { hostRoot: "something", version: "1" } };

    const result = await collect(runtime.run(req, context));
    expect(result).not.toContainEqual(
      expect.objectContaining({ text: expect.stringContaining("fixture-provider-key") }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("Provider request failed with key [redacted]"),
      }),
    );
    expect(broker.revoke).toHaveBeenCalled();
  });

  async function relayStatus(relayUrl: string, token: string): Promise<number | string> {
    try {
      const response = await fetch(`${relayUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "fixture-model",
          messages: [{ role: "user", content: "relay-probe" }],
        }),
      });
      await response.text();
      return response.status;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      return cause?.code ?? (error as { code?: string }).code ?? "error";
    }
  }

  it("refuses relay after turn end", async () => {
    const { token, open, broker } = grantBroker();
    const { report } = await runRelay(broker);

    expect(report.status).toBe(200);
    expect(report.relayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(open).toHaveBeenCalledOnce();
    const after = await relayStatus(report.relayUrl, token);
    expect(after === "ECONNREFUSED" || after === "ECONNRESET" || after === 403).toBe(true);
  });
});
