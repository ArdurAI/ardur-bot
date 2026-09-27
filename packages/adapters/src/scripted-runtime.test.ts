import type { AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { inferScript, ScriptedAgentRuntime } from "./scripted-runtime.js";

it("acknowledges a scripted turn after input acceptance and before output", async () => {
  const acknowledgeInput = vi.fn(async () => undefined);
  const runtime = new ScriptedAgentRuntime();
  const events = runtime.run({
    botId: "recipient",
    threadId: "thread",
    runId: "run",
    prompt: "Check the fixture",
    instructions: "",
    history: [],
    tools: [],
    model: { provider: "scripted", id: "scripted" },
    script: [{ assistant: "Checked.", complete: true }],
    inputReceipt: { leaseFence: 3, deliveryIds: ["delivery"] },
    acknowledgeInput,
  });
  expect((await events[Symbol.asyncIterator]().next()).value).toMatchObject({ type: "progress" });
  expect(acknowledgeInput).toHaveBeenCalledOnce();
  expect(acknowledgeInput).toHaveBeenCalledWith({
    runId: "run",
    leaseFence: 3,
    deliveryIds: ["delivery"],
    mode: "initial",
  });
  await events[Symbol.asyncIterator]().return?.();
});

it("uses a delegated card's goal rather than its envelope metadata for scripted intent", () => {
  const prompt = `This is a delegated task. <task_card>${JSON.stringify({
    goal: "Review the repository",
    approvalBoundaries: { connectors: [] },
  })}</task_card>`;
  expect(inferScript(prompt)).toEqual(inferScript("Review the repository"));
  expect(inferScript(prompt).flatMap((turn) => turn.toolCalls ?? [])).toEqual([]);
});

describe("inferScript message_bot", () => {
  const messageBotScript = (confirmName: string, message: string) => [
    {
      assistant: "messaging that bot now.",
      toolCalls: [
        {
          name: "message_bot",
          args: {
            confirm_name: confirmName,
            message,
            intent: "request",
          },
        },
      ],
      complete: true,
    },
  ];

  it("messages another bot by name", () => {
    expect(inferScript("message the bot named Researcher saying peer-exchange-alpha")).toEqual(
      messageBotScript("Researcher", "peer-exchange-alpha"),
    );
  });

  it("keeps message_bot when the payload mentions delete or subagent", () => {
    expect(
      inferScript(
        "message the bot named Researcher saying please delete the bot named Scout and use a subagent",
      ),
    ).toEqual(
      messageBotScript("Researcher", "please delete the bot named Scout and use a subagent"),
    );
  });

  it("keeps message_bot when the payload mentions sign in", () => {
    expect(inferScript("message the bot named Researcher saying please sign in")).toEqual(
      messageBotScript("Researcher", "please sign in"),
    );
  });

  it("preserves multiline message content", () => {
    expect(inferScript("message the bot named Researcher saying line one\nline two")).toEqual(
      messageBotScript("Researcher", "line one\nline two"),
    );
  });
});

describe("goal result transport", () => {
  const workerResult =
    "The sort is ascending, so the corrected wording is: Results show oldest first; sort results by createdAt ascending.";
  const reviewerResult =
    "Independent check: Results show oldest first; sort results by createdAt ascending. The original wording contradicts the ascending sort.";

  it("requires the delivered worker result before requesting review", () => {
    expect(() => inferScript("Review Worker's completed assignment")).toThrow(
      "Worker result was not delivered",
    );
    const review = inferScript(
      "Review Worker's completed assignment",
      undefined,
      false,
      workerResult,
    );
    expect(review[0]?.toolCalls?.[0]?.args).toMatchObject({
      card: {
        inputs: [
          { type: "text", text: "Results show oldest first; sort results by createdAt ascending." },
        ],
      },
    });
  });

  it("uses the delivered card input and reviewer result for the final answer", () => {
    const card = `<task_card>${JSON.stringify({
      goal: "Check the correction against the fixture: Results show newest first; sort results by createdAt ascending",
      inputs: [{ type: "text", text: "A different proposed sentence." }],
    })}</task_card>`;
    expect(inferScript(card)[0]?.assistant).toContain("A different proposed sentence.");
    expect(() => inferScript("Review Reviewer's completed assignment")).toThrow(
      "Reviewer result was not delivered",
    );
    expect(
      inferScript("Review Reviewer's completed assignment", undefined, false, reviewerResult)[0]
        ?.assistant,
    ).toContain("Results show oldest first; sort results by createdAt ascending.");
  });

  it("uses a fixed completion cue with the delivered result as data", () => {
    const cue = "Review the completed assignment and decide the next step for this goal.";
    expect(inferScript(cue, undefined, false, workerResult)[0]?.toolCalls?.[0]?.name).toBe(
      "message_bot",
    );
    expect(inferScript(cue, undefined, false, reviewerResult)[0]?.assistant).toContain(
      "Results show oldest first",
    );
  });
});

describe("inferScript quote markdown fixture", () => {
  it("returns the markdown fixture including the caller marker", () => {
    expect(inferScript("quote markdown fixture md-stamp")[0]?.assistant).toContain(
      "md-stamp\n1. list-a",
    );
  });
});

describe("inferScript propose an mcp server", () => {
  it("posts an add_mcp_server call with no static credential", () => {
    expect(inferScript("propose an mcp server for reports")).toEqual([
      {
        assistant: "posting an approval card for that server.",
        toolCalls: [
          {
            name: "add_mcp_server",
            args: {
              name: "Proposed MCP fixture",
              transport: "streamable_http",
              endpoint: "https://mcp-fixture.example.test/reports",
            },
          },
        ],
        complete: true,
      },
    ]);
  });

  it("uses the caller's name when the prompt names the server", () => {
    expect(
      inferScript("propose an mcp server named Reports Server")[0]?.toolCalls?.[0]?.args,
    ).toMatchObject({
      name: "Reports Server",
    });
  });
});

describe("inferScript request_secret", () => {
  it("opens a masked api key card via request_secret", () => {
    expect(inferScript("show a secret card for a masked api key")).toEqual([
      {
        assistant: "i need that value in a protected field.",
        toolCalls: [
          {
            name: "request_secret",
            args: {
              label: "API key",
              purpose: "api_key",
              credential: {
                name: "example_api",
                origin: "https://api.example.test",
                auth: { type: "bearer" },
              },
            },
          },
        ],
      },
    ]);
  });
});

describe("inferScript write_file", () => {
  it("posts the reply after the tool so a routine run still has a durable final", () => {
    expect(
      inferScript("write a file in your home called notes/result.txt that says routine-ok"),
    ).toEqual([
      {
        toolCalls: [
          { name: "write_file", args: { path: "notes/result.txt", content: "routine-ok\n" } },
        ],
      },
      { assistant: "writing that into my home now.", complete: true },
    ]);
  });
});

describe("inferScript update_bot", () => {
  it("silences finish notifications on this bot", () => {
    expect(inferScript("silence finish notifications")).toEqual([
      {
        assistant: "silencing finish notifications.",
        toolCalls: [{ name: "update_bot", args: { notifyOnFinish: false } }],
        complete: true,
      },
    ]);
  });

  it("resumes finish notifications on this bot", () => {
    expect(inferScript("resume finish notifications")).toEqual([
      {
        assistant: "enabling finish notifications.",
        toolCalls: [{ name: "update_bot", args: { notifyOnFinish: true } }],
        complete: true,
      },
    ]);
  });
});

describe("ScriptedAgentRuntime executionIds", () => {
  it("gives repeated tools distinct executionIds within a run", async () => {
    const runtime = new ScriptedAgentRuntime();
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run({
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      prompt: "ping",
      instructions: "",
      history: [],
      tools: [],
      model: { provider: "scripted", id: "scripted" },
      script: [
        {
          toolCalls: [
            { name: "message_agent", args: { address: "+15551111111", message: "one" } },
            { name: "message_agent", args: { address: "+15551111111", message: "two" } },
          ],
          complete: true,
        },
      ],
    })) {
      events.push(event);
    }

    const toolIds = events
      .filter(
        (event): event is Extract<AgentRuntimeEvent, { type: "tool" }> => event.type === "tool",
      )
      .map((event) => event.executionId);
    expect(toolIds).toEqual(["run-1:message_agent:0", "run-1:message_agent:1"]);
  });
});
