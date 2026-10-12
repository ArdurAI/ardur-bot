import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, AgentUsage } from "@ardurbot/adapter-kit";
import { failureCategoryMessage, RuntimePinError } from "@ardurbot/contracts";
import { HERMES_RUNTIME_V2_DEFAULTS } from "@ardurbot/contracts/runtime-config";
import {
  effectiveRuntimeConfigHash,
  runtimeConfigV2Hash,
} from "@ardurbot/core/node/runtime-config-hash";
import { compileHermesRuntimeConfig } from "@ardurbot/host-runtime/runtimes/hermes-config";
import { pinnedHermesLaunch } from "@ardurbot/host-runtime/runtimes/hermes-install";
import type { HermesProviderFailure } from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";
import { startHermesProviderRelay } from "@ardurbot/host-runtime/runtimes/hermes-provider-relay";
import { HermesRuntime } from "@ardurbot/host-runtime/runtimes/hermes-runtime";
import { createLogger, createTestSink } from "@ardurbot/logging";
import { expect, it } from "vitest";
import type { BrokerScope } from "./hermes-provider-broker.js";
import {
  HermesProviderBroker,
  HermesRelayDispatcher,
  setHermesProviderStream,
} from "./hermes-provider-broker.js";
import { catalogModels } from "./pi-runtime.js";

const GLM_PROVIDER = "zai-coding-cn";
const GLM_MODEL_ID = "glm-5.3";
const FIXTURE_KEY = "fixture-glm-key";
const UPSTREAM_BODY = "private-fixture-upstream-body";
const EXACT_WORDS = "hermes works ok";
const CONNECTION_ID = "fixture-connection";

type UpstreamMode = "text" | "tool" | "summary" | "429" | "403" | "500" | "cut";

type Wire = {
  path: string;
  body: Record<string, unknown>;
  fixtureKey: boolean;
  grantForwarded: boolean;
  userAgent: boolean;
};

export type TranslatedGlmResult = {
  events: AgentRuntimeEvent[];
  error: unknown;
  wires: Wire[];
  hermesKeys: string[][];
  failures: HermesProviderFailure[];
  called: string[];
  purposes: string[];
  text: string;
  homeRemoved: boolean;
  relayClosed: boolean;
  serverClosed: boolean;
  leak: string;
  diagnostic: string;
  installStatusBefore: string[];
  installStatusAfter: string[];
  installChanges: string[];
  cutObserved: boolean;
};

const installStatus = (root: string) =>
  execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line && !line.includes("contributors/emails/"));

/** Worktree bytes only. Git metadata is excluded so a status read cannot dirty the fingerprint. */
const installFingerprint = (root: string) => {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (dir === root && name === ".git") continue;
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(full);
      } catch {
        files.set(rel, "missing");
        continue;
      }
      if (stat.isSymbolicLink()) {
        try {
          files.set(rel, `link:${readlinkSync(full)}`);
        } catch {
          files.set(rel, "link:unreadable");
        }
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) {
        files.set(rel, `other:${stat.mode.toString(8)}`);
        continue;
      }
      try {
        files.set(
          rel,
          `${stat.mode.toString(8)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
        );
      } catch {
        files.set(rel, "unreadable");
      }
    }
  };
  walk(root);
  return files;
};

const fingerprintChanges = (before: Map<string, string>, after: Map<string, string>) => {
  const changed: string[] = [];
  for (const [rel, hash] of before) {
    if (!after.has(rel)) changed.push(`removed ${rel}`);
    else if (after.get(rel) !== hash) changed.push(`changed ${rel}`);
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) changed.push(`added ${rel}`);
  }
  changed.sort();
  if (changed.length <= 20) return changed;
  return [...changed.slice(0, 20), `and ${changed.length - 20} more`];
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const frame = (
  delta: Record<string, unknown>,
  finish: string | null,
  usage?: Record<string, number>,
) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: GLM_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;

const textStream = (words: string) =>
  [
    frame({ role: "assistant", reasoning_content: "Check the fixture." }, null),
    frame({ content: words }, null),
    frame({}, "stop", { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }),
    "data: [DONE]\n\n",
  ].join("");

const toolStream = (name: string) =>
  [
    frame({ role: "assistant", reasoning_content: "Use the supplied tool." }, null),
    frame(
      {
        tool_calls: [
          {
            index: 0,
            id: "call_fixture_1",
            type: "function",
            function: { name, arguments: '{"value":"hello"}' },
          },
        ],
      },
      null,
    ),
    frame({}, "tool_calls", { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }),
    "data: [DONE]\n\n",
  ].join("");

const zaiError = (code: string, message: string) =>
  JSON.stringify({ error: { code, message: `${message} ${UPSTREAM_BODY}` } });

const hasToolResult = (body: Record<string, unknown>) =>
  Array.isArray(body.messages) && body.messages.some((message) => object(message)?.role === "tool");

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error("Fixture request exceeded the limit."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function startFakeGlm(mode: UpstreamMode, toolName: string) {
  const wires: Wire[] = [];
  let grant = "";
  let cutObserved = false;
  let resolveChunk: () => void = () => {};
  let rejectChunk: (error: Error) => void = () => {};
  const chunkObserved = new Promise<void>((resolve, reject) => {
    resolveChunk = resolve;
    rejectChunk = reject;
  });
  const noteChunkObserved = () => {
    if (cutObserved) return;
    cutObserved = true;
    resolveChunk();
  };
  const server = createServer(async (req, res) => {
    try {
      const pathName = req.url ?? "";
      const raw = await readBody(req);
      const body = object(JSON.parse(raw || "{}")) ?? {};
      const authorization = req.headers.authorization ?? "";
      wires.push({
        path: pathName,
        body,
        fixtureKey: authorization === `Bearer ${FIXTURE_KEY}`,
        grantForwarded: grant.length > 0 && authorization.includes(grant),
        userAgent:
          typeof req.headers["user-agent"] === "string" && req.headers["user-agent"] !== "",
      });
      if (req.method !== "POST" || !pathName.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      if (mode === "429" || mode === "403" || mode === "500") {
        const status = Number(mode);
        const code = status === 429 ? "1305" : status === 403 ? "1220" : "1230";
        const message =
          status === 429
            ? "The service may be temporarily overloaded, please try again later."
            : status === 403
              ? "You do not have permission to access this fixture."
              : "API call process error";
        res.writeHead(status, { "content-type": "application/json" }).end(zaiError(code, message));
        return;
      }
      if (mode === "cut") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        const chunk = frame({ role: "assistant", content: "partial" }, null);
        await new Promise<void>((resolve, reject) => {
          res.write(chunk, (error) => (error ? reject(error) : resolve()));
        });
        const timer = setTimeout(() => {
          rejectChunk(new Error("The broker did not observe the stream chunk."));
        }, 20_000);
        try {
          await chunkObserved;
          res.destroy();
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      const words = mode === "summary" ? "Fixture brief." : EXACT_WORDS;
      const payload =
        mode === "tool" && Array.isArray(body.tools) && !hasToolResult(body)
          ? toolStream(toolName)
          : textStream(words);
      res.writeHead(200, { "content-type": "text/event-stream" }).end(payload);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake GLM server did not bind.");
  return {
    wires,
    baseUrl: `http://127.0.0.1:${address.port}/api/coding/paas/v4`,
    rememberGrant(token: string) {
      grant = token;
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
    listening: () => server.listening,
    noteChunkObserved,
    cutObserved: () => cutObserved,
  };
}

const closed = async (url: string) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch {
    return true;
  }
};

async function runTranslatedGlm(
  trusted: { python: string; root: string },
  mode: UpstreamMode,
): Promise<TranslatedGlmResult> {
  const installStatusBefore = installStatus(trusted.root);
  const beforePrint = installFingerprint(trusted.root);
  const models = catalogModels();
  const source = models.getModel(GLM_PROVIDER, GLM_MODEL_ID);
  if (!source) throw new Error("The GLM catalog model is missing.");
  const fake = await startFakeGlm(mode, "mcp__ardur__fixture_echo");
  const model = { ...source, baseUrl: fake.baseUrl };
  setHermesProviderStream((next, context, options) => {
    const stream = models.streamSimple(next, context, options);
    if (mode !== "cut") return stream;
    return (async function* () {
      for await (const event of stream) {
        if (event.type === "text_delta" && event.delta.length > 0) fake.noteChunkObserved();
        yield event;
      }
    })();
  });
  const maxTokens = mode === "summary" ? 2_000 : 1_024;
  const purpose = mode === "summary" ? "summary" : "main";
  const tools =
    mode === "tool"
      ? [
          {
            name: "fixture_echo",
            description: "Echo",
            parameters: { type: "object", properties: { value: { type: "string" } } },
          },
        ]
      : [];
  const settings = {
    ...HERMES_RUNTIME_V2_DEFAULTS,
    limits: { maxProviderRequests: 4, timeoutMs: 90_000 },
  };
  const compiled = compileHermesRuntimeConfig(settings, {
    id: GLM_MODEL_ID,
    contextWindow: source.contextWindow,
    maxTokens,
    reasoning: true,
    acceptsImages: false,
    thinkingLevel: "high",
  });
  const executionEnvelope = {
    runtimeKind: "hermes" as const,
    runtimeConfig: settings,
    runtimeConfigHash: runtimeConfigV2Hash(settings),
    effectiveRuntimeConfig: compiled.manifest,
    effectiveRuntimeConfigHash: effectiveRuntimeConfigHash(compiled.manifest),
  };
  const scope: BrokerScope = {
    runId: crypto.randomUUID(),
    botId: "fixture-bot",
    userId: "fixture-user",
    spaceId: "fixture-space",
    operationId: crypto.randomUUID(),
    leaseOwner: "fixture-worker",
    leaseFence: 1,
    hostGeneration: 1,
    configurationHash: executionEnvelope.effectiveRuntimeConfigHash,
    pin: {
      credentialId: CONNECTION_ID,
      provider: GLM_PROVIDER,
      modelId: GLM_MODEL_ID,
      effort: "high",
    },
  };
  const records: AgentUsage[] = [];
  const broker = new HermesProviderBroker({
    scope,
    connection: {
      credentialId: CONNECTION_ID,
      provider: GLM_PROVIDER,
      modelId: GLM_MODEL_ID,
      baseUrl: fake.baseUrl,
      route: "provider-translated",
      contextWindow: source.contextWindow,
      maxOutputTokens: maxTokens,
      acceptsImages: false,
      supportsDeveloperRole: false,
      effort: { field: "reasoning_effort", supported: ["high"] },
      reportedModel: "required",
    },
    credentialId: CONNECTION_ID,
    pinnedEffort: "high",
    catalog: { model, apiKey: FIXTURE_KEY },
    tools,
    purpose,
    maxRequests: 4,
    maxReservedTokens: 500_000,
    expiresAt: Date.now() + 180_000,
    active: async () => true,
    record: async (item) => {
      records.push(item);
    },
  });
  fake.rememberGrant(broker.grant.token);
  const failures: HermesProviderFailure[] = [];
  const hermesKeys: string[][] = [];
  const sink = createTestSink();
  const logger = createLogger({ service: "fixture", sinks: [sink], level: "info" });
  const dispatcher = new HermesRelayDispatcher({ broker, scope }, new AbortController().signal);
  let runtime: HermesRuntime | undefined;
  const relay = await startHermesProviderRelay(
    { protocol: 1, ...broker.grant, hostGeneration: crypto.randomUUID() },
    async (method, args) => {
      if (method === "provider.open") hermesKeys.push(Object.keys(object(args[0]) ?? {}).sort());
      return dispatcher.dispatch(method, args);
    },
    (failure) => {
      failures.push(failure);
      if (runtime) void runtime.fail(scope.runId, failure);
    },
    logger,
  );
  const launcher = path.resolve("packages/host-runtime/python/hermes_launcher.py");
  let home = "";
  let diagnostics = "";
  const launched = pinnedHermesLaunch(trusted.root, launcher);
  runtime = new HermesRuntime({
    command: trusted.python,
    args: [launcher],
    pinned: true,
    executionEnvelope,
    launch: async (spec) => {
      home = spec.env.HERMES_HOME ?? "";
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
    logger,
  });
  const called: string[] = [];
  const request: AgentRunRequest = {
    runId: scope.runId,
    botId: scope.botId,
    threadId: "fixture-thread",
    prompt:
      mode === "summary"
        ? "Summarize the fixture note."
        : mode === "tool"
          ? "Echo hello"
          : `Test: reply with exactly the words ${EXACT_WORDS}`,
    instructions:
      mode === "summary"
        ? "Maintain a factual brief. Output only the brief."
        : mode === "tool"
          ? "Use the supplied tool."
          : "Reply with the model's words.",
    history: [],
    tools:
      mode === "tool"
        ? [
            {
              name: "fixture_echo",
              description: "Echo",
              inputSchema: { type: "object", properties: { value: { type: "string" } } },
            },
          ]
        : "none",
    providerPurpose: mode === "summary" ? "summary" : undefined,
    model: {
      provider: GLM_PROVIDER,
      id: GLM_MODEL_ID,
      baseUrl: relay.url,
      apiKey: broker.grant.token,
      thinkingLevel: "high",
      contextWindow: source.contextWindow,
      maxTokens,
      acceptsImages: false,
      reasoning: true,
      runtimePin: {
        runtimeKind: "hermes",
        provider: GLM_PROVIDER,
        modelId: GLM_MODEL_ID,
        effort: "high",
        credentialId: CONNECTION_ID,
        revision: 1,
        runtimeConfig: settings,
        runtimeConfigHash: executionEnvelope.runtimeConfigHash,
        effectiveRuntimeConfig: compiled.manifest,
        effectiveRuntimeConfigHash: executionEnvelope.effectiveRuntimeConfigHash,
      } as unknown as AgentRunRequest["model"]["runtimePin"],
    },
    executeTool: async (name) => {
      called.push(name);
      return { text: "echoed" };
    },
  };
  const events: AgentRuntimeEvent[] = [];
  let error: unknown;
  try {
    try {
      for await (const event of runtime.run(request)) events.push(event);
    } catch (caught) {
      error = caught;
    }
  } finally {
    relay.close();
    broker.revoke();
    await fake.close();
  }
  const text = events.map((event) => (event.type === "text" ? event.text : "")).join("");
  const secrets = [FIXTURE_KEY, UPSTREAM_BODY, broker.grant.token];
  const scanned = JSON.stringify({
    events,
    error: error instanceof Error ? error.message : error,
    logs: sink.events,
    diagnostics,
    wires: fake.wires.map((wire) => ({
      path: wire.path,
      keys: Object.keys(wire.body),
      fixtureKey: wire.fixtureKey,
      grantForwarded: wire.grantForwarded,
    })),
  });
  const leak = secrets.find((secret) => scanned.includes(secret)) ?? "";
  const diagnostic =
    `${error instanceof Error ? error.message : ""} keys=${JSON.stringify(hermesKeys)} failures=${JSON.stringify(failures)} wires=${fake.wires.length}\n${diagnostics}`
      .replaceAll(trusted.root, "<install>")
      .replaceAll(broker.grant.token, "<grant>")
      .replaceAll(home || "<unset-home>", "<home>")
      .replaceAll(FIXTURE_KEY, "<key>")
      .replaceAll(UPSTREAM_BODY, "<upstream>");
  return {
    events,
    error,
    wires: fake.wires,
    hermesKeys,
    failures,
    called,
    purposes: records.map((record) => record.request?.purpose ?? ""),
    text,
    homeRemoved: home.length > 0 && !existsSync(home),
    relayClosed: await closed(`${relay.url}/chat/completions`),
    serverClosed: !fake.listening(),
    leak,
    diagnostic: `${diagnostic} cutObserved=${fake.cutObserved()}`,
    installStatusBefore,
    installStatusAfter: installStatus(trusted.root),
    installChanges: fingerprintChanges(beforePrint, installFingerprint(trusted.root)).map((line) =>
      line.replaceAll(trusted.root, "<install>"),
    ),
    cutObserved: fake.cutObserved(),
  };
}

const glmShape = {
  model: GLM_MODEL_ID,
  stream: true,
  stream_options: { include_usage: true },
  thinking: { type: "enabled", clear_thinking: false },
  reasoning_effort: "high",
};

function assertClean(result: TranslatedGlmResult) {
  expect(result.leak, result.diagnostic).toBe("");
  expect(result.homeRemoved, result.diagnostic).toBe(true);
  expect(result.relayClosed, result.diagnostic).toBe(true);
  expect(result.serverClosed, result.diagnostic).toBe(true);
  expect(result.wires.every((wire) => wire.fixtureKey && !wire.grantForwarded)).toBe(true);
  expect(result.installStatusAfter, "Pinned install status changed.").toEqual(
    result.installStatusBefore,
  );
  expect(
    result.installChanges,
    `Pinned install changed: ${result.installChanges.join(", ")}`,
  ).toEqual([]);
}

export function registerTranslatedGlmLane(trusted: { python: string; root: string }) {
  // Warm the install fingerprint before the first case. A cold walk of the pin can exceed the case budget.
  installFingerprint(trusted.root);
  it("completes a plain exact-word turn through the translated GLM route", async () => {
    const result = await runTranslatedGlm(trusted, "text");
    expect(result.error, result.diagnostic).toBeUndefined();
    expect(result.events.at(-1), result.diagnostic).toEqual({ type: "done" });
    expect(result.text.trim(), result.diagnostic).toBe(EXACT_WORDS);
    expect(result.wires, result.diagnostic).toHaveLength(1);
    expect(result.wires[0]?.body).toMatchObject(glmShape);
    expect(result.wires[0]?.body).not.toHaveProperty("store");
    expect(result.wires[0]?.body.tools).toBeUndefined();
    expect(result.wires[0]?.userAgent).toBe(true);
    assertClean(result);
  }, 240_000);

  it("completes one tool round trip through the translated GLM route", async () => {
    const result = await runTranslatedGlm(trusted, "tool");
    expect(result.error, result.diagnostic).toBeUndefined();
    expect(result.events.at(-1), result.diagnostic).toEqual({ type: "done" });
    expect(result.called, result.diagnostic).toEqual(["fixture_echo"]);
    expect(result.wires, result.diagnostic).toHaveLength(2);
    expect(result.wires[0]?.body).toMatchObject({
      ...glmShape,
      tool_stream: true,
    });
    expect(result.wires[1]?.body).toMatchObject(glmShape);
    expect(hasToolResult(result.wires[1]?.body ?? {})).toBe(true);
    expect(result.text).toContain(EXACT_WORDS);
    assertClean(result);
  }, 240_000);

  it("completes the summary request shape through the translated GLM route", async () => {
    const result = await runTranslatedGlm(trusted, "summary");
    expect(result.error, result.diagnostic).toBeUndefined();
    expect(result.events.at(-1), result.diagnostic).toEqual({ type: "done" });
    expect(result.text).toContain("Fixture brief.");
    expect(result.wires, result.diagnostic).toHaveLength(1);
    expect(result.wires[0]?.body).toMatchObject({ ...glmShape, max_tokens: 2_000 });
    expect(result.wires[0]?.body.tools).toBeUndefined();
    expect(result.hermesKeys[0]).not.toContain("tools");
    expect(result.purposes).toContain("summary");
    assertClean(result);
  }, 240_000);

  it("classifies an upstream 429 with a Z.AI error body as a provider refusal, not a Hermes limit", async () => {
    const result = await runTranslatedGlm(trusted, "429");
    expect(result.failures[0], result.diagnostic).toEqual({
      kind: "provider-http",
      status: 429,
      layer: "upstream",
      reason: "http-rate-limit",
      // The provider's recognized, non-secret reason code is kept for diagnosis.
      reasonCode: "1305",
    });
    expect(result.error, result.diagnostic).toBeInstanceOf(RuntimePinError);
    expect((result.error as RuntimePinError).problem.reasonId).toBe("provider-rate-limit");
    expect((result.error as Error).message).not.toBe(
      failureCategoryMessage("usage-limit", { runtime: "Hermes" }),
    );
    expect((result.error as Error).message).toMatch(/is refusing requests right now/);
    expect(result.events.at(-1)).not.toEqual({ type: "done" });
    assertClean(result);
  }, 240_000);

  it.each([
    [403, "http-auth", "provider-auth-failed"],
    [500, "http-server", "provider-request-failed"],
  ] as const)(
    "classifies upstream %s through the translated GLM route",
    async (status, reason, category) => {
      const result = await runTranslatedGlm(trusted, String(status) as "403" | "500");
      expect(result.failures[0], result.diagnostic).toEqual({
        kind: "provider-http",
        status,
        layer: "upstream",
        reason,
      });
      expect(result.error, result.diagnostic).toBeInstanceOf(RuntimePinError);
      expect((result.error as RuntimePinError).problem.reasonId).toBe(category);
      expect((result.error as Error).message).toBe(
        failureCategoryMessage(category, { runtime: "Hermes" }),
      );
      assertClean(result);
    },
    240_000,
  );

  it("fails a stream cut mid-response without completing the turn", async () => {
    const result = await runTranslatedGlm(trusted, "cut");
    expect(result.cutObserved, result.diagnostic).toBe(true);
    expect(result.error, result.diagnostic).toBeInstanceOf(RuntimePinError);
    expect(
      result.events.some((event) => event.type === "done"),
      result.diagnostic,
    ).toBe(false);
    expect(result.failures[0], result.diagnostic).toEqual({
      kind: "provider-failed",
      layer: "provider-adapter",
      reason: "provider-stream",
    });
    expect((result.error as RuntimePinError).problem.reasonId).toBe("provider-request-failed");
    expect((result.error as Error).message).toBe(
      failureCategoryMessage("provider-request-failed", { runtime: "Hermes" }),
    );
    assertClean(result);
  }, 240_000);
}
