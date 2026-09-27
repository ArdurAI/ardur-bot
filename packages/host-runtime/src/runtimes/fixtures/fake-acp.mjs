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
  if (value.method !== "session/prompt") return;
  if (scenario === "malformed") {
    process.stdout.write("{broken\n");
    return;
  }
  if (scenario === "oversize") {
    process.stdout.write(`${"x".repeat(9 * 1024 * 1024)}\n`);
    return;
  }
  if (scenario === "exit") process.exit(4);
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
    message(
      JSON.stringify({
        homeMatches: home === process.env.HOME,
        cwdMatches: (await realpath(process.cwd())) === (await realpath(join(home, "workspace"))),
        parentSecretAbsent: process.env.ARDUR_PARENT_SECRET === undefined,
        configHasKey: JSON.stringify(config).includes(process.env.ARDUR_HERMES_PROVIDER_KEY),
        config,
        context,
        prompt: value.params.prompt,
      }),
    );
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
  if (scenario === "before-tool" || scenario === "during-tool") {
    await new Promise((resolve) => setTimeout(resolve, scenario === "before-tool" ? 500 : 25));
  }
  if (
    [
      "tool",
      "before-tool",
      "during-tool",
      "ask-user",
      "takeover",
      "pending-tool-malformed",
    ].includes(scenario)
  ) {
    if (scenario === "pending-tool-malformed") message("before protocol failure.");
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
      scenario === "ask-user"
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
      scenario === "ask-user"
        ? { question: "Which path?", options: ["First", "Second"] }
        : scenario === "takeover"
          ? { reason: "Please take over." }
          : { value: "hello" };
    const result = await client.callTool({ name: toolName, arguments: args });
    message(JSON.stringify(result.content));
    await client.close();
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
