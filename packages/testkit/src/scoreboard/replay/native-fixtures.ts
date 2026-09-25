import type { ReplayFixture } from "./protocol.js";

/** Synthetic, versioned protocol examples. They are not recordings of installed CLI acceptance. */
export const CODEX_PROTOCOL_FIXTURE: ReplayFixture = {
  version: 1,
  protocol: "codex-jsonrpc",
  route: {
    provider: "openai",
    model: "fixture-model",
    runtime: "codex-app-server",
    protocolVersion: "app-server-v2",
  },
  initial: "start",
  terminal: ["done"],
  exchanges: [
    {
      id: "thread-start",
      from: "start",
      to: "done",
      variables: [],
      request: {
        id: 0,
        method: "thread/start",
        params: { model: "fixture-model", approvalPolicy: "never", sandbox: "read-only" },
      },
      response: {
        status: 200,
        headers: {},
        chunks: [
          '{"id":0,"result":{"thread":{"id":"thread-fixture"},',
          '"model":"fixture-model","modelProvider":"openai","sandbox":{"type":"readOnly"}}}\n',
        ],
        end: "complete",
      },
    },
  ],
};

export const CLAUDE_PROTOCOL_FIXTURE: ReplayFixture = {
  version: 1,
  protocol: "claude-stream-json",
  route: {
    provider: "anthropic",
    model: "claude-opus-5",
    runtime: "claude-code",
    protocolVersion: "stream-json-2.1.259",
  },
  initial: "start",
  terminal: ["done"],
  exchanges: [
    {
      id: "invocation",
      from: "start",
      to: "done",
      variables: [],
      request: {
        args: [
          "-p",
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--model",
          "claude-opus-5",
          "--effort",
          "low",
          "--system-prompt",
          "Use the current synthetic policy.",
          "--tools",
          "",
          "--restricted",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{"ardur":{"command":"fixture-node","args":[]}}}',
          "--allowedTools",
          "mcp__ardur__*",
          "--permission-mode",
          "dontAsk",
          "--permission-prompts",
          "none",
          "--disable-slash-commands",
          "--no-chrome",
          "--settings",
          '{"disableAllHooks":true,"switchModelsOnFlag":false,"fallbackModel":[]}',
          "--session-id",
          "fixture-session",
        ],
        input: { type: "user", message: { role: "user", content: "Read the policy." } },
        tools: [
          {
            name: "read_file",
            description: "Read a fixture file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
      response: {
        status: 200,
        headers: {},
        chunks: [
          '{"type":"system","subtype":"init","model":"claude-opus-5","session_id":"fixture-session","tools":["mcp__ardur__read_file"]}\n',
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Policy received."}}}\n',
          '{"type":"result","subtype":"success","is_error":false,"modelUsage":{"claude-opus-5":{}}}\n',
        ],
        end: "complete",
      },
    },
  ],
};
