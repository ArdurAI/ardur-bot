import { describe, expect, it, vi } from "vitest";
import { contentDigest } from "../scoreboard/manifest.js";
import {
  inspectLocalRoute,
  parseQualificationArguments,
  runQualification,
} from "./qualification.js";
import { planPairs } from "./scheduler.js";

const expected = {
  origin: "http://127.0.0.1:11434",
  model: "qwen3:8b",
  digest: contentDigest("synthetic-model"),
  quantization: "Q4_K_M",
  contextSize: 32768,
};
function fixture() {
  const tag = { name: expected.model, digest: expected.digest, size: 100 };
  const show = {
    template: "synthetic-template",
    details: { quantization_level: expected.quantization },
    model_info: {
      "general.architecture": "qwen3",
      "qwen3.context_length": 40960,
      "tokenizer.ggml.tokens": ["synthetic"],
    },
    capabilities: ["completion", "tools"],
  };
  const responses: unknown[] = [
    { models: [tag] },
    { version: "0.0.0-test" },
    show,
    { models: [tag] },
    { version: "0.0.0-test" },
  ];
  const requests: { url: string; init?: RequestInit }[] = [];
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json(responses.shift());
  }) as typeof fetch;
  return { responses, show, transport, requests };
}
describe("non-generating live prerequisites", () => {
  it("prints help without probing or discovery and rejects accidental live options", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await runQualification([])).toBe(0);
      expect(parseQualificationArguments(["--help"])).toBeNull();
      expect(() => parseQualificationArguments(["--live"])).toThrow();
      expect(() => parseQualificationArguments(["--out", "report", "--out", "again"])).toThrow();
    } finally {
      output.mockRestore();
    }
  });
  it("freezes a four-run ceiling from verified metadata without generation or product qualification", async () => {
    const f = fixture();
    const result = await inspectLocalRoute(expected, f.transport);
    expect(f.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/tags",
      "/api/version",
      "/api/show",
      "/api/tags",
      "/api/version",
    ]);
    expect(f.requests.filter(({ init }) => init?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(f.requests[2]!.init!.body as string)).toEqual({
      model: expected.model,
      verbose: true,
    });
    expect(
      f.requests.every(
        ({ init }) =>
          init?.redirect === "error" &&
          init?.signal &&
          !JSON.stringify(init?.headers).includes("authorization"),
      ),
    ).toBe(true);
    expect(result).toMatchObject({
      toolRoundTrip: "not-run",
      effectiveContext: null,
      generationRequests: 0,
    });
    expect(result.budget.contextSize).toBe(32768);
    expect(result.budget.model.digest).toBe(expected.digest);
    expect(result.budget.model.tokenizerHash).toBe(
      contentDigest({ "tokenizer.ggml.tokens": ["synthetic"] }),
    );
    expect(planPairs(result.budget.cohort)).toHaveLength(2);
    expect(result.budget.global.requests).toBe(48);
    expect(result.budget.perTrial.requests).toBe(12);
    expect(result.budget.currency.cap).toBe(0);
  });
  it.each([
    "https://paid.invalid",
    "http://127.0.0.1:11434/path",
    "http://localhost:11434",
    "http://user@127.0.0.1:11434",
  ])("refuses undeclared origin %s before opening a socket", async (origin) => {
    const f = fixture();
    await expect(inspectLocalRoute({ ...expected, origin }, f.transport)).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
  it("stops on initial digest drift before requesting model details", async () => {
    const f = fixture();
    f.responses[0] = { models: [{ name: expected.model, digest: contentDigest("changed") }] };
    await expect(inspectLocalRoute(expected, f.transport)).rejects.toThrow("digest drift");
    expect(f.requests).toHaveLength(1);
  });
  it.each(["quantization", "context", "tokenizer", "tag-race", "server-race"])(
    "refuses %s without inventing a route pin",
    async (change) => {
      const f = fixture();
      if (change === "quantization") f.show.details.quantization_level = "Q8";
      if (change === "context") f.show.model_info["qwen3.context_length"] = 4096;
      if (change === "tokenizer") f.show.model_info["tokenizer.ggml.tokens"] = [];
      if (change === "tag-race") f.responses[3] = { models: [] };
      if (change === "server-race") f.responses[4] = { version: "changed" };
      await expect(inspectLocalRoute(expected, f.transport)).rejects.toThrow();
      expect(f.requests.length).toBeLessThanOrEqual(5);
      expect(f.requests.some(({ url }) => /generate|chat|pull|create/.test(url))).toBe(false);
    },
  );
  it("caps response memory and refuses malformed model identity before discovery", async () => {
    const f = fixture();
    await expect(
      inspectLocalRoute({ ...expected, digest: "0".repeat(64) }, f.transport),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
    const transport = vi.fn(
      async () => new Response("x".repeat(16 * 1024 * 1024 + 1)),
    ) as typeof fetch;
    await expect(inspectLocalRoute(expected, transport)).rejects.toThrow("byte cap");
  });
});
