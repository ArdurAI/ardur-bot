import { writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scenario = process.argv[2] ?? "text";
let sessionId = "fixture-session";
let nextId = 700;
const pending = new Map();
let mcp;
let pendingPromptId;

function send(value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
}

function update(value) {
  send({ method: "session/update", params: { sessionId, update: value } });
}

function message(text) {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

async function requestClient(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

async function handle(value) {
  if (value.id && !value.method) {
    pending.get(value.id)?.(value);
    pending.delete(value.id);
    return;
  }
  if (value.method === "initialize") {
    send({
      id: value.id,
      result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } },
    });
    return;
  }
  if (value.method === "session/new") {
    if (!value.params?.cwd || !Array.isArray(value.params?.mcpServers)) process.exit(3);
    sessionId = `fixture-${process.pid}`;
    mcp = value.params.mcpServers[0];
    if (scenario === "pinned-session-schema") {
      // The pinned ACP stdio schema requires argv and a list of named strings.
      if (
        typeof value.params.cwd !== "string" ||
        typeof mcp?.name !== "string" ||
        typeof mcp.command !== "string" ||
        !Array.isArray(mcp.args) ||
        !mcp.args.every((arg) => typeof arg === "string") ||
        !Array.isArray(mcp.env) ||
        !mcp.env.every((item) => typeof item.name === "string" && typeof item.value === "string")
      ) {
        send({ id: value.id, error: { code: -32602, message: "Invalid params" } });
        return;
      }
    }
    if (scenario.startsWith("session-new-context-")) {
      process.stderr.write("fixture traceback detail\n".repeat(9));
      send({
        id: value.id,
        error: {
          code: scenario === "session-new-context-wrong-code" ? -32602 : -32603,
          message: "Internal error",
          data: {
            details: `Model fixture-private-model has a context window of 32,768 tokens, which is below the minimum ${scenario === "session-new-context-other-floor" ? "128,000" : "64,000"} required by Hermes Agent. Choose a model with at least 64K context.`,
            prompt: "fixture private prompt",
          },
        },
      });
      return;
    }
    if (scenario.startsWith("session-new-catalog-")) {
      send({
        id: value.id,
        error: {
          code: scenario === "session-new-catalog-wrong-code" ? -32602 : -32603,
          message: "Internal error",
          data: {
            details:
              scenario === "session-new-catalog-other"
                ? "fixture unrelated failure"
                : "Constructed tool catalog changed",
            prompt: "private fixture prompt",
          },
        },
      });
      return;
    }
    if (scenario === "session-new-closed") process.exit(4);
    if (
      scenario === "session-new-error" ||
      scenario === "session-new-long-error" ||
      scenario === "session-new-escaped-error" ||
      scenario === "session-new-interleaved-error" ||
      scenario === "session-new-control-error"
    ) {
      const secrets = [
        process.env.ARDUR_HERMES_PROVIDER_KEY,
        mcp.args.at(-1),
        mcp.env.find(({ name }) => name === "BRIDGE_TOKEN")?.value,
      ];
      const sequences = ["\x1b[0m", "\x1b]0;fixture title\x07", "\x1bM"];
      const message = `session refused: ${secrets
        .map((secret, index) =>
          scenario === "session-new-escaped-error"
            ? `${secret.slice(0, 8)}${sequences[index]}${secret.slice(8)}`
            : scenario === "session-new-interleaved-error"
              ? [...secret].join(["\t", "\u00a0\u2028", "\u0301\u2029"][index])
              : secret,
        )
        .join(" ")}`;
      send({
        id: value.id,
        error: {
          code: -32602,
          message:
            scenario === "session-new-control-error"
              ? `${message}\n\r\t\x01\x7f\x1b[31mforged\rline\t\x1b[0m${" \n\r\t".repeat(200)}${"x".repeat(230)} ${secrets[0]} end`
              : scenario === "session-new-long-error"
                ? `${message} ${"x".repeat(500)}`
                : message,
          data: { message: "fixture private error data", prompt: "fixture private prompt" },
        },
      });
      return;
    }
    if (scenario === "profile-construction-tool") {
      const client = new Client({ name: "fixture", version: "0.1.0" });
      const transport = new StdioClientTransport({
        command: mcp.command,
        args: mcp.args,
        env: {
          ...process.env,
          ...Object.fromEntries(mcp.env.map(({ name, value }) => [name, value])),
        },
        stderr: "pipe",
      });
      await client.connect(transport);
      let result;
      try {
        result = await client.callTool({ name: "fixture_echo", arguments: { value: "early" } });
      } catch {
        result = { isError: true };
      }
      writeFileSync(
        join(process.env.HERMES_HOME, "construction-result.json"),
        JSON.stringify({ isError: result.isError === true }),
      );
      await client.close();
    }
    if (scenario === "profile-normalized-catalog") {
      // Pinned tools/mcp_tool.py normalizes each component before registration;
      // the owned launcher checks that exact resulting catalog after new_session.
      const client = new Client({ name: "fixture", version: "0.1.0" });
      const transport = new StdioClientTransport({
        command: mcp.command,
        args: mcp.args,
        env: Object.fromEntries(mcp.env.map(({ name, value }) => [name, value])),
      });
      await client.connect(transport);
      const listed = await client.listTools();
      const actual = listed.tools
        .map(({ name }) => `mcp__ardur__${name.replace(/[^A-Za-z0-9_]/g, "_")}`)
        .sort();
      await client.close();
      if (JSON.stringify(actual) !== process.env.ARDUR_HERMES_ALLOWED_TOOLS) {
        send({
          id: value.id,
          error: {
            code: -32603,
            message: "Internal error",
            data: { details: "Constructed tool catalog changed" },
          },
        });
        return;
      }
    }
    if (["profile-ack", "profile-stale", "profile-normalized-catalog"].includes(scenario))
      writeFileSync(
        join(process.env.HERMES_HOME, "runtime-ack.json"),
        JSON.stringify({
          profile: "hermes-ardur-v2",
          configurationHash:
            scenario === "profile-stale" ? "0".repeat(64) : process.env.ARDUR_HERMES_EXPECTED_HASH,
          sessionId,
        }),
        { mode: 0o600, flag: "wx" },
      );
    send({ id: value.id, result: { sessionId } });
    return;
  }
  if (value.method === "session/cancel") {
    process.exit(0);
  }
  if (scenario === "pending-tool-malformed" && value.method === "fixture/fail-now") {
    process.stdout.write("{broken\n");
    return;
  }
  if (scenario === "pending-tool-malformed" && value.method === "fixture/finish-now") {
    send({ id: pendingPromptId, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "pending-tool-malformed" && value.method === "fixture/forbidden-now") {
    update({
      sessionUpdate: "tool_call",
      toolCallId: "native-late",
      title: "terminal: unavailable",
      status: "pending",
    });
    return;
  }
  if (scenario === "pending-tool-malformed" && value.method === "fixture/overflow-now") {
    for (let i = 0; i < 260; i++)
      update({ sessionUpdate: "plan", entries: [{ content: `step ${i}` }] });
    return;
  }
  if (scenario === "queue-overflow" && value.method === "fixture/overflow") {
    for (let i = 0; i < 260; i++)
      update({ sessionUpdate: "plan", entries: [{ content: `step ${i}` }] });
    return;
  }
  if (value.method !== "session/prompt") return;
  if (scenario === "hold") return;
  if (scenario === "pending-tool-malformed") pendingPromptId = value.id;
  if (scenario === "malformed") {
    process.stdout.write("{broken\n");
    return;
  }
  if (scenario === "oversize") {
    process.stdout.write(`${"x".repeat(9 * 1024 * 1024)}\n`);
    return;
  }
  if (scenario === "exit") process.exit(4);
  if (scenario === "stderr-bridge") {
    process.stderr.write(
      `${mcp.args.at(-1)}\n${mcp.env.find(({ name }) => name === "BRIDGE_TOKEN")?.value}\n${process.env.ARDUR_HERMES_PROVIDER_KEY}\n`,
    );
    process.exit(4);
  }
  if (scenario === "stderr-failure") {
    process.stderr.write("fixture diagnostic before failure\n");
    process.stderr.write("fixture prompt contents\nfixture document contents\n");
    process.stderr.write(`key=${process.env.ARDUR_HERMES_PROVIDER_KEY}\n`);
    process.exit(4);
  }
  if (
    scenario === "provider-usage-limit" ||
    scenario === "provider-signed-out" ||
    scenario === "provider-model-missing" ||
    scenario === "provider-unknown"
  ) {
    const text =
      scenario === "provider-usage-limit"
        ? "HTTP 429: rate limit exceeded, usage limit reached"
        : scenario === "provider-signed-out"
          ? "HTTP 401: invalid api key"
          : scenario === "provider-model-missing"
            ? "model fixture-pro is not available"
            : "upstream socket reset";
    send({ id: value.id, error: { code: -32000, message: text } });
    return;
  }
  if (scenario === "held-malformed") {
    message(`before failure ${process.env.ARDUR_HERMES_PROVIDER_KEY[0]}`);
    process.stdout.write("{broken\n");
    return;
  }
  if (scenario === "held-native") {
    message(`before failure ${process.env.ARDUR_HERMES_PROVIDER_KEY[0]}`);
    update({
      sessionUpdate: "tool_call",
      toolCallId: "native-held",
      title: "terminal: unavailable",
    });
    return;
  }
  if (scenario === "native" || scenario === "foreign-mcp") {
    update({
      sessionUpdate: "tool_call",
      toolCallId: "native-1",
      title: scenario === "native" ? "terminal: unavailable" : "mcp__ardur__unlisted",
      status: "pending",
    });
    if (scenario === "foreign-mcp") send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "buffered-native") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before violation" } } } })}\n${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "native-2", title: "terminal: unavailable", status: "pending" } } })}\n`,
    );
    return;
  }
  if (scenario === "poison-text" || scenario === "non-object-content") {
    update({
      sessionUpdate: "agent_message_chunk",
      content:
        scenario === "poison-text"
          ? { type: "text", text: { toString: null } }
          : "not an ACP content block",
    });
    return;
  }
  if (scenario === "permission") {
    const answer = await requestClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "permission-1", title: "terminal", status: "pending" },
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    });
    message(answer.result?.outcome?.optionId === "deny" ? "denied" : "wrong permission result");
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "client-capabilities") {
    const answer = await requestClient("fs/read_text_file", { path: "/fixture" });
    message(answer.error?.code === -32601 ? "capability denied" : "wrong capability result");
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "inspect") {
    const home = process.env.HERMES_HOME;
    const config = JSON.parse(await readFile(join(home, "config.yaml"), "utf8"));
    const context = await readFile(join(home, "SOUL.md"), "utf8");
    const report = {
      homeMatches: home === process.env.HOME,
      cwdMatches: (await realpath(process.cwd())) === (await realpath(join(home, "workspace"))),
      parentSecretAbsent: process.env.ARDUR_PARENT_SECRET === undefined,
      configHasKey: JSON.stringify(config).includes(process.env.ARDUR_HERMES_PROVIDER_KEY),
      config,
      env: process.env,
      context,
      prompt: value.params.prompt,
      providerKey: process.env.ARDUR_HERMES_PROVIDER_KEY ?? null,
      baseUrl: process.env.ARDUR_HERMES_RELAY_URL ?? null,
    };
    // Stdout is redacted with whatever key this process was given, so the
    // unredacted proof has to be a file the parent reads after the turn.
    if (process.env.ARDUR_HERMES_INSTALL) {
      writeFileSync(
        join(process.env.ARDUR_HERMES_INSTALL, "spawn-report.json"),
        JSON.stringify(report),
        {
          mode: 0o600,
        },
      );
    }
    message(JSON.stringify(report));
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "redact") {
    const relayKey = mcp.args.at(-1);
    process.stderr.write(`${process.env.ARDUR_HERMES_PROVIDER_KEY} ${relayKey}\n`);
    message(`prefix ${process.env.ARDUR_HERMES_PROVIDER_KEY.slice(0, 4)}`);
    message(`${process.env.ARDUR_HERMES_PROVIDER_KEY.slice(4)} ${relayKey} suffix`);
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "redact-boundaries") {
    const relayKey = mcp.args.at(-1);
    const chunks =
      value.params.prompt[0].text === "three"
        ? [relayKey.slice(0, 1), relayKey.slice(1, -1), relayKey.slice(-1)]
        : (() => {
            const cut = Number(value.params.prompt[0].text);
            return [relayKey.slice(0, cut), relayKey.slice(cut)];
          })();
    message("prefix ");
    for (const chunk of chunks) message(chunk);
    message(` ${process.env.ARDUR_HERMES_PROVIDER_KEY} suffix`);
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "redact-labelled-boundary") {
    const kind = value.params.prompt[0].text;
    const secret = kind === "provider" ? process.env.ARDUR_HERMES_PROVIDER_KEY : mcp.args.at(-1);
    message(`${kind === "provider" ? "Bearer " : "token="}${secret.slice(0, 1)}`);
    message(secret.slice(1));
    message(" suffix");
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "redact-overlap") {
    const kind = value.params.prompt[0].text;
    const secret = kind === "provider" ? process.env.ARDUR_HERMES_PROVIDER_KEY : mcp.args.at(-1);
    message(`${secret}${kind === "provider" ? "i" : secret.slice(0, 1)}`);
    message("!");
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "redact-overlap-three") {
    const secret = process.env.ARDUR_HERMES_PROVIDER_KEY;
    message(secret.slice(0, -1));
    message(`${secret.slice(-1)}i`);
    message("!");
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "defaulted-usage") {
    message("completed");
    send({
      id: value.id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      },
    });
    return;
  }
  if (scenario === "text-burst") {
    const frames = Array.from({ length: 600 }, () =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        },
      }),
    );
    frames.push(
      JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { stopReason: "end_turn" } }),
    );
    process.stdout.write(`${frames.join("\n")}\n`);
    return;
  }
  if (scenario === "before-tool" || scenario === "during-tool") {
    await new Promise((resolve) => setTimeout(resolve, scenario === "before-tool" ? 500 : 25));
  }
  if (
    [
      "tool",
      "before-tool",
      "during-tool",
      "ask-user",
      "ask-user-held-text",
      "tool-held-text",
      "tool-held-text-complete",
      "tool-split-secret",
      "takeover",
      "pending-tool-malformed",
      "queue-overflow",
    ].includes(scenario)
  ) {
    if (scenario === "pending-tool-malformed" || scenario === "queue-overflow")
      message("before protocol failure.");
    if (
      scenario === "ask-user-held-text" ||
      scenario === "tool-held-text" ||
      scenario === "tool-held-text-complete"
    )
      message(`Please approve the dif${process.env.ARDUR_HERMES_PROVIDER_KEY[0]}`);
    const splitSecret =
      scenario === "tool-split-secret"
        ? value.params.prompt[0].text === "provider"
          ? process.env.ARDUR_HERMES_PROVIDER_KEY
          : mcp.args.at(-1)
        : undefined;
    if (splitSecret) message(`before ${splitSecret.slice(0, 4)}`);
    const client = new Client({ name: "fixture", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: mcp.command,
      args: mcp.args,
      env: {
        ...process.env,
        ...Object.fromEntries(mcp.env.map(({ name, value }) => [name, value])),
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    const listed = await client.listTools();
    const toolName =
      scenario === "ask-user" || scenario === "ask-user-held-text"
        ? "ask_user"
        : scenario === "takeover"
          ? "request_takeover"
          : "fixture_echo";
    if (listed.tools.length !== 1 || listed.tools[0].name !== toolName) process.exit(5);
    update({
      sessionUpdate: "tool_call",
      toolCallId: "mcp-1",
      title: `mcp__ardur__${toolName}`,
      status: "pending",
    });
    const args =
      scenario === "ask-user" || scenario === "ask-user-held-text"
        ? { question: "Which path?", options: ["First", "Second"] }
        : scenario === "takeover"
          ? { reason: "Please take over." }
          : { value: "hello" };
    const result = await client.callTool({ name: toolName, arguments: args });
    message(
      scenario === "tool-split-secret"
        ? `${splitSecret.slice(4)} after tool`
        : scenario === "tool-held-text-complete"
          ? " after tool"
          : JSON.stringify(result.content),
    );
    await client.close();
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (scenario === "relay") {
    const relayUrl = process.env.ARDUR_HERMES_RELAY_URL;
    const response = await fetch(`${relayUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.ARDUR_HERMES_PROVIDER_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture-model",
        messages: [{ role: "user", content: "relay-probe" }],
      }),
    });
    // The parent redacts child text with the key it handed this process, so the
    // acceptance proof is a file the test reads, not the assistant transcript.
    writeFileSync(
      join(process.env.ARDUR_HERMES_INSTALL, "relay-report.json"),
      JSON.stringify({ status: response.status, relayUrl }),
      { mode: 0o600 },
    );
    message("relay accepted");
    send({ id: value.id, result: { stopReason: "end_turn" } });
    return;
  }
  message("first ");
  message("second");
  send({ id: value.id, result: { stopReason: "end_turn" } });
}

for await (const line of createInterface({ input: process.stdin })) {
  try {
    void handle(JSON.parse(line)).catch(() => process.exit(6));
  } catch {
    process.exit(6);
  }
}
