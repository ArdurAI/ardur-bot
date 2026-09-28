import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { HermesRuntimeConfigSchema } from "@ardurbot/contracts/runtime-pins";
import {
  hermesLauncherAsset,
  pinnedHermesLaunch,
  probeHermesInstall,
} from "@ardurbot/host-runtime/runtimes/hermes-install";
import { startHermesProviderRelay } from "@ardurbot/host-runtime/runtimes/hermes-provider-relay";
import { HermesRuntime } from "@ardurbot/host-runtime/runtimes/hermes-runtime";
import { expect, it } from "vitest";
import type { BrokerScope } from "./hermes-provider-broker.js";
import { HermesProviderBroker } from "./hermes-provider-broker.js";

const install = process.env.ARDUR_HERMES_INSTALL;
let qualified: ReturnType<typeof probeHermesInstall> | undefined;
if (process.env.ARDUR_HERMES_INSTALL_LANE === "1" && install) {
  try {
    qualified = probeHermesInstall(install);
  } catch {
    // The opt-in lane records a skip when its designated install is unavailable.
  }
}

const status = (root: string) =>
  execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line && !line.includes("contributors/emails/"));

const packet = (modelId: string, delta: Record<string, unknown>, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

if (!qualified) {
  it.skip("pinned install lane skipped: set both ARDUR_HERMES_INSTALL_LANE=1 and a qualified ARDUR_HERMES_INSTALL", () => {});
} else {
  const trusted = qualified;
  const runInstallLane = async (modelId: string) => {
    const before = status(trusted.root);
    const scope: BrokerScope = {
      runId: crypto.randomUUID(),
      botId: "fixture-bot",
      userId: "fixture-user",
      spaceId: "fixture-space",
      operationId: crypto.randomUUID(),
      leaseOwner: "fixture-worker",
      leaseFence: 1,
      hostGeneration: 1,
      configurationHash: "fixture-config",
      pin: {
        credentialId: "fixture-connection",
        provider: "fixture",
        modelId,
        effort: "high",
      },
    };
    const requests: Record<string, unknown>[] = [];
    const usage: unknown[] = [];
    const broker = new HermesProviderBroker({
      scope,
      connection: {
        credentialId: "fixture-connection",
        provider: "fixture",
        modelId,
        baseUrl: "http://127.0.0.1:7766/v1",
        route: "openai-completions",
        contextWindow: 65_536,
        maxOutputTokens: 1024,
        acceptsImages: true,
        supportsDeveloperRole: false,
        effort: { field: "reasoning_effort", supported: ["high"] },
        reportedModel: "required",
      },
      credentialId: "fixture-connection",
      pinnedEffort: "high",
      tools: [
        {
          name: "fixture_echo",
          description: "Echo",
          parameters: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
      maxRequests: 4,
      maxReservedTokens: 4 * (65_536 + 1024),
      expiresAt: Date.now() + 180_000,
      active: async () => true,
      record: async (item) => {
        usage.push(item);
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        const tools = (body.tools as { function: { name: string } }[] | undefined) ?? [];
        const hasReply = (body.messages as { role: string }[]).some(
          (message) => message.role === "tool",
        );
        const delta =
          !hasReply && tools.some((tool) => tool.function.name === "mcp__ardur__fixture_echo")
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fixture_1",
                    type: "function",
                    function: { name: "mcp__ardur__fixture_echo", arguments: '{"value":"hello"}' },
                  },
                ],
              }
            : { role: "assistant", content: "completed" };
        const finish = "tool_calls" in delta ? "tool_calls" : "stop";
        return new Response(
          [packet(modelId, delta, null), packet(modelId, {}, finish), "data: [DONE]\n\n"].join(""),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });
    let response: Buffer | undefined;
    let brokerError = "";
    let sequence = 0;
    const relay = await startHermesProviderRelay(
      { protocol: 1, ...broker.grant, hostGeneration: crypto.randomUUID() },
      async (method, args) => {
        if (method === "provider.open") {
          let opened: Response;
          try {
            opened = await broker.open({
              grant: broker.grant,
              scope,
              path: "/v1/chat/completions",
              body: args[0],
            });
          } catch (error) {
            const submitted = args[0] as Record<string, unknown>;
            brokerError = `${error instanceof Error ? error.message : String(error)} keys=${Object.keys(submitted)} tools=${JSON.stringify(submitted.tools)} max=${submitted.max_tokens ?? submitted.max_completion_tokens} model=${submitted.model} effort=${submitted.reasoning_effort}`;
            throw error;
          }
          response = Buffer.from(await opened.arrayBuffer());
          sequence = 0;
          return { status: opened.status, contentType: "text/event-stream" };
        }
        if (method === "provider.read") {
          if (!response || args[0] !== sequence) throw new Error("Sequence changed");
          const chunk = response.subarray(sequence * 24 * 1024, (sequence + 1) * 24 * 1024);
          const done = (sequence + 1) * 24 * 1024 >= response.length;
          const seq = sequence++;
          if (done) response = undefined;
          return { seq, chunk: chunk.toString("base64"), done };
        }
        return undefined;
      },
    );
    const launcher = path.resolve("packages/host-runtime/python/hermes_launcher.py");
    let home = "";
    let diagnostics = "";
    let launchEnv: Record<string, string> | undefined;
    const launched = pinnedHermesLaunch(trusted.root, launcher);
    const runtime = new HermesRuntime({
      command: trusted.python,
      args: [launcher],
      pinned: true,
      launch: async (spec) => {
        home = spec.env.HERMES_HOME ?? "";
        launchEnv = spec.env;
        const result = await launched(spec);
        result.child.stderr.on("data", (chunk: Buffer) => {
          diagnostics = (diagnostics + chunk.toString()).slice(-4096);
        });
        return result;
      },
      onTurnFinished: () => {
        relay.close();
        broker.revoke();
      },
    });
    const called: string[] = [];
    const request: AgentRunRequest = {
      runId: scope.runId,
      botId: scope.botId,
      threadId: "fixture-thread",
      prompt: "Echo hello",
      instructions: "Use the supplied tool.",
      history: [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
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
      tools: [
        {
          name: "fixture_echo",
          description: "Echo",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
      model: {
        provider: "fixture",
        id: modelId,
        baseUrl: relay.url,
        apiKey: broker.grant.token,
        thinkingLevel: "high",
        contextWindow: 65_536,
        maxTokens: 1024,
        acceptsImages: true,
        reasoning: true,
        runtimePin: {
          runtimeKind: "hermes",
          provider: "fixture",
          modelId,
          effort: "high",
          credentialId: "fixture-connection",
          revision: 1,
          runtimeConfig: HermesRuntimeConfigSchema.parse({
            version: 1,
            maxProviderRequests: 4,
            timeoutMs: 90_000,
          }),
        },
      },
      executeTool: async (name) => {
        called.push(name);
        return { text: "echoed" };
      },
    };
    const events: AgentRuntimeEvent[] = [];
    try {
      try {
        for await (const event of runtime.run(request)) events.push(event);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${detail}\n${diagnostics}`
            .replaceAll(trusted.root, "<install>")
            .replaceAll(broker.grant.token, "<grant>")
            .replaceAll(home || "<unset-home>", "<home>"),
        );
      }
      expect(launchEnv?.ARDUR_HERMES_MAX_ITERATIONS).toBe("4");
      expect(launchEnv?.ARDUR_HERMES_RUN_BUDGET_SECONDS).toBe("90");
      expect(events.at(-1)).toEqual({ type: "done" });
      expect(requests, `${JSON.stringify(events)}; broker: ${brokerError}`).toHaveLength(2);
      expect(requests.map((body) => body.tools)).toEqual([
        [
          {
            type: "function",
            function: expect.objectContaining({ name: "mcp__ardur__fixture_echo" }),
          },
        ],
        [
          {
            type: "function",
            function: expect.objectContaining({ name: "mcp__ardur__fixture_echo" }),
          },
        ],
      ]);
      expect(called).toEqual(["fixture_echo"]);
      expect(requests).toHaveLength(2);
      for (const body of requests) {
        expect(body.model).toBe(modelId);
        if (modelId === "gpt-4.1") {
          expect(body.max_completion_tokens).toBe(1024);
          expect(body).not.toHaveProperty("max_tokens");
        } else {
          expect(body.max_tokens).toBe(1024);
          expect(body).not.toHaveProperty("max_completion_tokens");
        }
        expect(body.reasoning_effort).toBe("high");
        expect(
          (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name),
        ).toEqual(["mcp__ardur__fixture_echo"]);
      }
      expect(JSON.stringify(requests[0])).toContain("Earlier question");
      expect(JSON.stringify(requests[0])).toContain("data:image/png;base64,");
      expect(usage.length).toBeGreaterThan(0);
    } finally {
      relay.close();
      broker.revoke();
    }
    expect(home).toBeTruthy();
    expect(existsSync(home)).toBe(false);
    expect(status(trusted.root)).toEqual(before);
  };
  it.each(["fixture-model", "gpt-4.1"])(
    "runs the pinned launcher through the broker and Ardur MCP bridge with %s",
    runInstallLane,
    240_000,
  );
}

it("resolves the launcher beside a relocated host bundle", () => {
  expect(hermesLauncherAsset(path.join("/fixture", "host-service", "host-service.cjs"))).toBe(
    path.join("/fixture", "host-service", "python", "hermes_launcher.py"),
  );
});
