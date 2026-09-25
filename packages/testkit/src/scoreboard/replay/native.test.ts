import type { AgentRunRequest, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { expect, it } from "vitest";
import {
  ClaudeStreamParser,
  claudeArguments,
} from "../../../../adapters/src/runtimes/claude-code-runtime.js";
import { CodexRpc } from "../../../../adapters/src/runtimes/codex-app-server-runtime.js";
import { jsonLines } from "../../../../adapters/src/runtimes/native-process.js";
import { replayNativeProcess } from "./native.js";
import { CLAUDE_PROTOCOL_FIXTURE, CODEX_PROTOCOL_FIXTURE } from "./native-fixtures.js";

it("replays fragmented native RPC bytes through the production Codex parser", async () => {
  const fixture = replayNativeProcess(CODEX_PROTOCOL_FIXTURE);
  const rpc = new CodexRpc(fixture.child);
  try {
    await expect(
      rpc.request("thread/start", {
        model: "fixture-model",
        approvalPolicy: "never",
        sandbox: "read-only",
      }),
    ).resolves.toMatchObject({ thread: { id: "thread-fixture" }, model: "fixture-model" });
    fixture.assertComplete();
  } finally {
    fixture.close();
  }
});

it("rejects a changed native pin, permission policy or undeclared request", async () => {
  for (const params of [
    { model: "other", approvalPolicy: "never", sandbox: "read-only" },
    { model: "fixture-model", approvalPolicy: "always", sandbox: "read-only" },
  ]) {
    const fixture = replayNativeProcess(CODEX_PROTOCOL_FIXTURE);
    const rpc = new CodexRpc(fixture.child);
    await expect(rpc.request("thread/start", params)).rejects.toThrow();
    expect(() => fixture.assertComplete()).toThrow("mismatch");
    fixture.close();
  }
});

it("matches the complete Claude invocation and tool schema before releasing parsed content", async () => {
  const request: AgentRunRequest = {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: "fixture-run",
    prompt: "Read the policy.",
    instructions: "Use the current synthetic policy.",
    history: [],
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
    model: {
      provider: "anthropic",
      id: "claude-opus-5",
      runtimePin: {
        runtimeKind: "claude-code",
        provider: "anthropic",
        modelId: "claude-opus-5",
        effort: "low",
        credentialId: "native:claude-code",
        revision: 1,
      },
    },
  };
  const fixture = replayNativeProcess(CLAUDE_PROTOCOL_FIXTURE);
  fixture.child.on("error", () => undefined);
  fixture.child.stdin.write(
    `${JSON.stringify({ args: claudeArguments(request, { command: "fixture-node", args: [] }, "fixture-session"), input: { type: "user", message: { role: "user", content: request.prompt } }, tools: request.tools })}\n`,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  fixture.close();
  const parser = new ClaudeStreamParser(request.model.runtimePin!);
  const events: AgentRuntimeEvent[] = [parser.startUsage()];
  for await (const message of jsonLines(fixture.child)) events.push(...parser.parse(message));
  fixture.assertComplete();
  expect(events).toMatchObject([
    { type: "usage", request: { collection: { outcome: "started" } } },
    { type: "text", text: "Policy received." },
    { type: "usage", request: { collection: { outcome: "success" } } },
    { type: "done" },
  ]);
  const usage = events.filter((event) => event.type === "usage");
  expect(usage[0]!.request!.requestId).toBe(usage[1]!.request!.requestId);
  for (const observation of usage)
    expect(observation).toMatchObject({
      reported: false,
      request: {
        categories: { logicalInput: null, output: null },
        collection: { scope: "native-turn", availability: "unavailable" },
      },
    });
});
