import type { AgentUsage } from "@ardurbot/adapter-kit";
import { DELEGATION_LIMITS } from "@ardurbot/contracts";
import { hermesContextDocument } from "@ardurbot/host-runtime/runtimes/hermes-runtime";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "./executor.js";
import type { BrokerOptions, BrokerRequest } from "./hermes-provider-broker.js";
import { HermesProviderBroker, hermesToolName } from "./hermes-provider-broker.js";
import { brokerLedgerFixture } from "./hermes-run-budget-ledger.fixture.js";
import { requestReservationTokens } from "./request-usage.js";

// Production host catalog: graphical computer, no page browser, no optional
// semantic memory or cloud agents. The launcher omits run_subagent.
const tools = selectBuiltinToolsForRun({
  graphicalToolsAllowed: true,
  pageBrowserAllowed: false,
  groupId: null,
  trigger: "message",
  semanticMemoryEnabled: false,
  messagingChannelRun: false,
})
  .filter((tool) => tool.name !== "run_subagent")
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as Record<string, unknown>,
  }));
const contextWindow = 1_000_000;
const outputCap = 65_536;
const runAllowance = 16 * (contextWindow + outputCap);
// Fake prior results fill the existing default supplied-context limit. No
// captured prompts, credentials or real tool output are used.
const requiredContext = hermesContextDocument({
  instructions: "Use only the supplied tools.",
  history: [{ role: "assistant", content: "Earlier fixture result. ".repeat(1_000) }],
} as Parameters<typeof hermesContextDocument>[0]);
const mainBody = {
  model: "glm-5.3",
  messages: [
    { role: "system", content: requiredContext },
    { role: "user", content: "Read the fixture note and report its contents." },
  ],
  tools: tools.map((tool) => ({
    type: "function",
    function: { ...tool, name: hermesToolName(tool.name) },
  })),
  max_tokens: outputCap,
  stream: false,
};

function fixture(
  patch: {
    goal?: boolean;
    used?: number;
    allowance?: number;
    requests?: number;
    summary?: boolean;
    translated?: boolean;
  } = {},
) {
  const records: AgentUsage[] = [];
  const ledger = brokerLedgerFixture(patch);
  const scope: BrokerOptions["scope"] = {
    runId: "fixture-run",
    botId: "fixture-bot",
    userId: "fixture-user",
    spaceId: "fixture-space",
    operationId: "fixture-operation",
    leaseOwner: "fixture-worker",
    leaseFence: 1,
    hostGeneration: 1,
    configurationHash: "fixture-configuration",
    pin: {
      credentialId: "fixture-connection",
      provider: "openai-compatible",
      modelId: "glm-5.3",
      effort: "high",
    },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        JSON.stringify({
          model: "glm-5.3",
          choices: [
            {
              message: { role: "assistant", content: "Fixture completed." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 14_000, completion_tokens: 128 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const streamSimple = vi.fn(async function* (): AsyncGenerator<AssistantMessageEvent> {
    const message: Extract<AssistantMessageEvent, { type: "done" }>["message"] = {
      role: "assistant",
      content: [{ type: "text", text: "Fixture completed." }],
      api: "openai-completions",
      provider: "zai",
      model: "glm-5.3",
      usage: {
        input: 14_000,
        output: 128,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14_128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    yield { type: "start", partial: message };
    yield { type: "text_start", contentIndex: 0, partial: message };
    yield { type: "text_delta", contentIndex: 0, delta: "Fixture completed.", partial: message };
    yield { type: "text_end", contentIndex: 0, content: "Fixture completed.", partial: message };
    yield { type: "done", reason: "stop", message };
  });
  const options: BrokerOptions = {
    scope,
    connection: {
      credentialId: "fixture-connection",
      provider: "openai-compatible",
      modelId: "glm-5.3",
      baseUrl: "http://127.0.0.1:1/v1",
      route: patch.translated ? "provider-translated" : "openai-completions",
      contextWindow,
      maxOutputTokens: patch.summary ? 4_096 : outputCap,
      acceptsImages: false,
      supportsDeveloperRole: false,
      effort: { field: "reasoning_effort", supported: ["high"] },
      reportedModel: "required",
    },
    credentialId: "fixture-connection",
    pinnedEffort: "high",
    tools: patch.summary ? [] : tools,
    purpose: patch.summary ? "summary" : "main",
    maxRequests: patch.requests ?? 16,
    maxReservedTokens: patch.allowance ?? runAllowance,
    expiresAt: Date.now() + 60_000,
    active: async () => true,
    requiredContext,
    fetch,
    ...(patch.translated ? { streamSimple } : {}),
    record: async (usage) => {
      await ledger.record(usage);
      records.push(usage);
    },
  };
  const broker = new HermesProviderBroker(options);
  const body = patch.summary
    ? {
        model: "glm-5.3",
        messages: [
          { role: "system", content: requiredContext },
          { role: "user", content: "Summarize the fixture." },
        ],
        max_tokens: 4_096,
        stream: false,
      }
    : mainBody;
  const request = (): BrokerRequest => ({
    grant: broker.grant,
    scope,
    path: "/v1/chat/completions",
    body,
  });
  return { broker, fetch, streamSimple, records, request, body, ledger };
}

describe("Hermes run and root budget separation", () => {
  it("completes a real 56-tool host request without treating the default delegation ceiling as its run limit", async () => {
    expect(tools).toHaveLength(56);
    expect(Buffer.byteLength(requiredContext)).toBeLessThanOrEqual(16_384);
    const bytes = Buffer.byteLength(JSON.stringify({ ...mainBody, reasoning_effort: "high" }));
    const reservation = requestReservationTokens(
      JSON.stringify({ ...mainBody, reasoning_effort: "high" }),
      contextWindow,
      outputCap,
    );
    // biome-ignore lint/suspicious/noConsole: bounded fixture measurements, never production request data.
    console.info("Hermes fixture bounds", {
      bytes,
      reservation,
      defaultRoot: DELEGATION_LIMITS.tokens,
      runAllowance,
    });
    expect(bytes).toBeLessThan(256 * 1024);
    expect(reservation).toBeGreaterThan(DELEGATION_LIMITS.tokens);
    const f = fixture();
    const response = await f.broker.open(f.request());
    expect((await response.json()).choices[0].message.content).toBe("Fixture completed.");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.records[0]?.request?.admission?.reservedTokens).toBe(reservation);
    expect(f.records.at(-1)?.request?.collection?.outcome).toBe("success");
    expect(f.records.at(-1)?.inputTokens).toBe(14_000);
    expect(f.records.at(-1)?.outputTokens).toBe(128);
    expect(f.ledger.root.usedTokens).toBe(14_128);
    expect(f.ledger.root.reservedTokens).toBe(0);
    expect(f.ledger.rows.size).toBe(1);
    // Reservations are not reported usage, and follow-up calls use the same run allowance.
    const next = await f.broker.open(f.request());
    expect(next.ok).toBe(true);
    await next.text();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("completes the next full-size provider request after asking room members", async () => {
    const f = fixture({ used: 100_000 });
    await (await f.broker.open(f.request())).text();
    await f.ledger.ask([36_864]);
    expect(f.ledger.root.tokenLimit).toBeGreaterThan(DELEGATION_LIMITS.tokens);
    await (await f.broker.open(f.request())).text();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.ledger.rows.size).toBe(2);
  });

  it.each([false, true])(
    "completes the same large main and no-tool summary through provider translation (summary=%s)",
    async (summary) => {
      const f = fixture({
        translated: true,
        summary,
        used: summary ? DELEGATION_LIMITS.tokens : 0,
      });
      const response = await f.broker.open(f.request());
      expect((await response.json()).choices[0].message.content).toBe("Fixture completed.");
      expect(f.streamSimple).toHaveBeenCalledOnce();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.records.at(-1)?.request?.collection?.outcome).toBe("success");
    },
  );

  it("admits brief maintenance under the inherited run allowance after the default root ceiling was spent", async () => {
    const f = fixture({ summary: true, used: DELEGATION_LIMITS.tokens });
    const response = await f.broker.open(f.request());
    expect(await response.text()).toContain("Fixture completed.");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.records[0]?.request?.purpose).toBe("summary");
    expect(f.records[0]?.request?.admission?.maxReservedTokens).toBe(runAllowance);
  });

  it.each([
    { goal: true },
    { allowance: 100_000 },
    { summary: true, goal: true, used: DELEGATION_LIMITS.tokens },
    { summary: true, allowance: 20_000 },
  ])("still refuses a configured goal or run allowance: %j", async (patch) => {
    const f = fixture(patch);
    await expect(f.broker.open(f.request())).rejects.toMatchObject({
      failure: { kind: "grant-refused", category: "run-budget" },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(0);
  });

  it("still bounds cumulative reservations and request count", async () => {
    const reservation = requestReservationTokens(
      JSON.stringify({ ...mainBody, reasoning_effort: "high" }),
      contextWindow,
      outputCap,
    );
    for (const patch of [{ allowance: reservation }, { requests: 1 }]) {
      const f = fixture(patch);
      await (await f.broker.open(f.request())).text();
      await expect(f.broker.open(f.request())).rejects.toMatchObject({
        failure: { kind: "grant-refused", category: "run-budget" },
      });
      expect(f.fetch).toHaveBeenCalledOnce();
    }
  });
});
