import type { RuntimePin } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { AntigravityDiagnostics, AntigravityStreamParser } from "./antigravity-stream.js";

const pin: RuntimePin = {
  runtimeKind: "antigravity",
  provider: "antigravity",
  modelId: "gemini-3.8-flash-low",
  effort: "low",
  credentialId: "native:antigravity",
  revision: 1,
};
const init = { event: "init", init: { model: pin.modelId } };
it("streams text and maps reported counters without cost", () => {
  const parser = new AntigravityStreamParser(pin);
  parser.parse(init);
  expect(
    parser.parse({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: "Hi" },
    }),
  ).toEqual([{ type: "text", text: "Hi" }]);
  parser.parse({
    event: "result",
    result: {
      status: "SUCCESS",
      response: "Hi",
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 3 },
    },
  });
  expect(parser.finishUsage("success")).toMatchObject([
    {
      type: "usage",
      provider: "antigravity",
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 3,
      request: { cost: null, categories: { reasoning: 1 } },
    },
  ]);
});
it("fails on a tool step even when the terminal record claims success", () => {
  const parser = new AntigravityStreamParser(pin);
  parser.parse(init);
  expect(() => parser.parse({ event: "step_update", step_update: { step_type: "tool" } })).toThrow(
    expect.objectContaining({ problem: expect.objectContaining({ code: "runtime-unavailable" }) }),
  );
});
it("classifies model errors without init and refuses model substitution", () => {
  expect(() =>
    new AntigravityStreamParser(pin).parse({
      event: "result",
      result: { status: "ERROR", error: "invalid model selection" },
    }),
  ).toThrow(
    expect.objectContaining({ problem: expect.objectContaining({ code: "pin-model-unknown" }) }),
  );
  expect(() =>
    new AntigravityStreamParser(pin).parse({ event: "init", init: { model: "other" } }),
  ).toThrow(
    expect.objectContaining({ problem: expect.objectContaining({ code: "pin-model-unknown" }) }),
  );
});
it("retains usage reported on a failed terminal result", () => {
  const parser = new AntigravityStreamParser(pin);
  parser.parse(init);
  expect(() =>
    parser.parse({
      event: "result",
      result: {
        status: "ERROR",
        error: "request failed",
        usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 1, cache_read_tokens: 3 },
      },
    }),
  ).toThrow();
  expect(parser.finishUsage("failed")).toMatchObject([
    {
      inputTokens: 10,
      outputTokens: 2,
      request: { cost: null, collection: { outcome: "failed" } },
    },
  ]);
});
it("recognises a bounded stderr diagnostic without retaining its text", () => {
  const diagnostics = new AntigravityDiagnostics();
  diagnostics.feed("AGY_ER");
  diagnostics.feed("ROR: private detail\n");
  expect(diagnostics.agyError).toBe(true);
  expect(JSON.stringify(diagnostics)).not.toContain("private detail");
});
