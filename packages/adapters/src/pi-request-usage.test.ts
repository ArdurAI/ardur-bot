import type { AgentRunRequest, AgentRuntimeEvent, AgentUsage } from "@ardurbot/adapter-kit";
import { normalizeUsageCounts } from "@ardurbot/adapter-kit";
import { startModelEmulator } from "@ardurbot/testkit/model-emulator";
import { afterEach, describe, expect, it } from "vitest";
import { piWireUsage } from "./pi-request-usage.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { ObservedUsageTotals } from "./runtime-usage.js";
import { startScoreboardTrace, traceRuntime } from "./scoreboard-trace.js";

const cleanups: Array<() => Promise<void>> = [];
async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const result: AgentRuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
const run = (
  model: AgentRunRequest["model"],
  extra: Partial<AgentRunRequest> = {},
): AgentRunRequest => ({
  botId: "fixture-bot",
  threadId: "fixture-thread",
  runId: crypto.randomUUID(),
  prompt: "Complete the synthetic task.",
  instructions: "Use the fixed fixture.",
  history: [],
  tools: "none",
  model,
  ...extra,
});
function totals(events: AgentUsage[]) {
  const result = new ObservedUsageTotals();
  for (const event of events) result.observe(event);
  return result;
}
describe("Pi raw numeric mappings", () => {
  it("maps inclusive cache and reasoning subsets without billing them twice", () => {
    const raw = piWireUsage("openai-completions", {
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 8 },
      },
      secret: "fixture-secret",
    });
    expect(raw).not.toHaveProperty("secret");
    expect(normalizeUsageCounts(raw!, "total-with-cache-subsets").categories).toEqual({
      logicalInput: 100,
      uncachedInput: 30,
      cacheReadInput: 60,
      cacheWriteInput: 10,
      output: 20,
      reasoning: 8,
    });
  });
  it("maps Anthropic additive fields and retains the cache TTL subset", () => {
    const raw = piWireUsage("anthropic-messages", {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 60,
          cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_1h_input_tokens: 20 },
        },
      },
    });
    expect(normalizeUsageCounts(raw!, "additive-cache-categories")).toMatchObject({
      raw: { cacheWrite1h: 20 },
      categories: { logicalInput: 100, output: 0, reasoning: null },
    });
  });
  it("does not infer usage from provider text or empty usage", () => {
    expect(
      piWireUsage("openai-responses", { response: { output: "input_tokens: 100" } }),
    ).toBeNull();
    expect(
      normalizeUsageCounts(
        piWireUsage("openai-responses", { response: { usage: {} } })!,
        "total-with-cache-subsets",
      ).categories.output,
    ).toBeNull();
  });
});

describe("Pi requests through real HTTP/SSE and SDK retry policy", () => {
  it.each([503, 429])(
    "records every retried HTTP %s attempt and its failed usage",
    async (status) => {
      const server = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: { type: "error", status, message: "Synthetic transient error" },
          },
          {
            expect() {},
            response: { type: "text", text: "done" },
            usage: { inputTokens: 120, outputTokens: 40 },
          },
        ],
      });
      cleanups.push(server.close);
      const trace = startScoreboardTrace();
      cleanups.push(async () => trace.stop());
      const events = await collect(
        traceRuntime("run-trace", 1, new PiAgentRuntime().run(run(server.model))),
      );
      const points = trace.snapshot().points;
      expect(points.filter((p) => p.boundary === "provider.started")).toHaveLength(2);
      expect(
        points.filter((p) => p.boundary === "provider.finished").map((p) => p.outcome),
      ).toEqual(["failed", "success"]);
      expect(new Set(points.map((p) => p.traceId))).toEqual(new Set(["run-trace"]));
      expect(points.filter((p) => p.boundary === "provider.text")).toHaveLength(1);
      expect(points.filter((p) => p.boundary === "wait.quota")).toHaveLength(
        status === 429 ? 1 : 0,
      );
      server.assertComplete();
      const usage = events.filter((event) => event.type === "usage");
      expect(totals(usage).tokens).toBe(160);
      expect(new Set(usage.map((event) => event.request?.requestId)).size).toBe(1);
      expect(new Set(usage.map((event) => event.request?.attemptId)).size).toBe(2);
      expect(usage).toContainEqual(
        expect.objectContaining({
          request: expect.objectContaining({
            purpose: "main",
            collection: expect.objectContaining({ outcome: "failed", availability: "unavailable" }),
          }),
        }),
      );
      expect(usage.at(-1)?.request).toMatchObject({
        purpose: "retry",
        collection: { outcome: "success", raw: { input: 120, output: 40 } },
        cost: null,
      });
      expect(events.at(-1)).toEqual({ type: "done", text: "done" });
    },
  );
  it("separates parent and helper requests while preserving parent identity and helper admission", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "helper-call",
            name: "run_subagent",
            arguments: { name: "fixture", task: "Complete helper fixture" },
          },
          usage: { inputTokens: 80, outputTokens: 20 },
        },
        {
          expect() {},
          response: { type: "text", text: "helper done" },
          usage: { inputTokens: 200, outputTokens: 40 },
        },
        {
          expect() {},
          response: { type: "text", text: "parent done" },
          usage: { inputTokens: 50, outputTokens: 10 },
        },
      ],
    });
    cleanups.push(server.close);
    const helper: AgentUsage[] = [];
    const events = await collect(
      new PiAgentRuntime().run(
        run(server.model, {
          tools: [
            {
              name: "run_subagent",
              description: "Run admitted helper",
              inputSchema: { type: "object" },
            },
          ],
          admitHelper: async () => ({
            id: "fixture-helper",
            tokens: 10000,
            deadlineAt: new Date(Date.now() + 30000).toISOString(),
          }),
          recordHelperUsage: async (id, usage) => {
            expect(id).toBe("fixture-helper");
            helper.push(usage);
          },
          finishHelper: async (_id, status) => {
            expect(status).toBe("completed");
          },
        }),
      ),
    );
    server.assertComplete();
    const main = events.filter((event) => event.type === "usage");
    expect(totals(main).tokens).toBe(160);
    expect(totals(helper).tokens).toBe(240);
    expect(helper.every((event) => event.request?.purpose === "helper")).toBe(true);
    expect(helper[0]?.request?.parentRequestId).toBe(main[0]?.request?.requestId);
    expect(new Set(main.map((event) => event.request?.requestId)).size).toBe(2);
    expect(events.at(-1)).toEqual({ type: "done", text: "parent done" });
  });
  it.each([undefined, { inputTokens: 0, outputTokens: 0 }])(
    "distinguishes omitted usage from a measured zero (%j)",
    async (supplied) => {
      const server = await startModelEmulator({
        steps: [{ expect() {}, response: { type: "text", text: "done" }, usage: supplied }],
      });
      cleanups.push(server.close);
      const events = await collect(new PiAgentRuntime().run(run(server.model)));
      server.assertComplete();
      const usage = events.filter((event) => event.type === "usage");
      expect(usage.at(-1)?.request?.categories.logicalInput).toBe(supplied ? 0 : null);
      expect(totals(usage).reported).toBe(Boolean(supplied));
    },
  );
  it("closes rejected requests even when no provider totals arrive", async () => {
    const server = await startModelEmulator({
      steps: [
        { expect() {}, response: { type: "error", status: 400, message: "Synthetic rejection" } },
      ],
    });
    cleanups.push(server.close);
    const events: AgentRuntimeEvent[] = [];
    await expect(
      (async () => {
        for await (const event of new PiAgentRuntime().run(run(server.model))) events.push(event);
      })(),
    ).rejects.toThrow();
    server.assertComplete();
    expect(
      events.filter((event) => event.type === "usage").at(-1)?.request?.collection,
    ).toMatchObject({ outcome: "failed", availability: "unavailable" });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });
});
