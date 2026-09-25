import { describe, expect, it, vi } from "vitest";
import { contentDigest } from "../scoreboard/manifest.js";
import {
  assessContainerCohort,
  inspectLocalRoute,
  parseQualificationArguments,
  parseServingContext,
  runQualification,
} from "./qualification.js";
import { planPairs } from "./scheduler.js";

const expected = {
  origin: "http://127.0.0.1:11434",
  model: "qwen3:8b",
  digest: contentDigest("synthetic-model"),
  quantization: "Q4_K_M",
  contextSize: 64000,
};
function fixture() {
  const tag = { name: expected.model, digest: expected.digest, size: 100 };
  const show = {
    template: "synthetic-template",
    details: { quantization_level: expected.quantization },
    model_info: {
      "general.architecture": "qwen3",
      "qwen3.context_length": 131072,
      "tokenizer.ggml.tokens": ["synthetic"],
    },
    capabilities: ["completion", "tools"],
  };
  const responses: unknown[] = [
    { models: [tag] },
    { version: "0.0.0-test" },
    show,
    { models: [{ ...tag, context_length: 64000 }] },
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
  it("plans a container cohort only from an explicit lane and approval value", () => {
    const required = [
      "--expected-hermes-revision",
      "29112bef099274229cadff79cdff7bf7b99c4b77",
      "--endpoint",
      "http://127.0.0.1:11434",
      "--model",
      "qwen3:8b",
      "--model-digest",
      "a".repeat(64),
      "--quantization",
      "Q4_K_M",
      "--context-size",
      "32768",
      "--out",
      "report",
    ];
    expect(parseQualificationArguments(required)).not.toHaveProperty("--container-cohort-approval");
    expect(
      parseQualificationArguments([
        ...required,
        "--lane",
        "container",
        "--container-cohort-approval",
        "approved",
        "--container-report",
        "container-qualification.json",
      ]),
    ).toMatchObject({
      "--lane": "container",
      "--container-cohort-approval": "approved",
    });
    expect(() => parseQualificationArguments([...required, "--lane", "native"])).toThrow(
      "Unknown qualification lane",
    );
    expect(() =>
      parseQualificationArguments([...required, "--container-cohort-approval", "approved"]),
    ).toThrow("require --lane container");
    expect(() =>
      parseQualificationArguments([
        ...required,
        "--lane",
        "container",
        "--container-cohort-approval",
        "yes",
      ]),
    ).toThrow("explicit value approved");
  });
  it("keeps the container canary blocked when the approved context is below the Hermes minimum", () => {
    const counter = { cap: 2, admitted: 2, nextRefused: true, effectAfterRefusal: false };
    const report = {
      realModelCalls: 0,
      imagePulls: 0,
      packageDownloads: 0,
      checks: [
        {
          name: "aggregate-disk-cap",
          passed: true,
          evidence: { mechanism: "tmpfs-size", capBytes: 8388608, containerAlive: true },
        },
        {
          name: "tool-and-descendant-admission",
          passed: true,
          evidence: {
            toolCalls: counter,
            descendants: { helpers: counter, commands: counter },
          },
        },
        { name: "product-tool-round-trip", passed: true, evidence: {} },
        {
          name: "dependency-manifest",
          passed: true,
          evidence: { missingPackages: [], missingBytes: 0 },
        },
      ],
    };
    const blocked = assessContainerCohort({
      approval: "approved",
      report,
      routeContext: 32768,
      architectureMaximum: 40960,
      servingContext: null,
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.gates.aggregateDisk).toBe(true);
    expect(blocked.gates.toolAndDescendantAdmission).toBe(true);
    expect(blocked.gates.productToolRoundTrip).toBe(true);
    expect(blocked.failures.join("\n")).toContain("64000");
    expect(blocked.failures.join("\n")).toContain("active context");
    expect(
      assessContainerCohort({
        approval: undefined,
        report: null,
        routeContext: 32768,
        architectureMaximum: 40960,
        servingContext: null,
      }).gates.approval,
    ).toBe(false);
  });
  it("makes the approved cohort ready only with an attested context inside both bounds", () => {
    const counter = { cap: 2, admitted: 2, nextRefused: true, effectAfterRefusal: false };
    const report = {
      realModelCalls: 0,
      imagePulls: 0,
      packageDownloads: 0,
      checks: [
        {
          name: "aggregate-disk-cap",
          passed: true,
          evidence: { mechanism: "tmpfs-size", capBytes: 8388608, containerAlive: true },
        },
        {
          name: "tool-and-descendant-admission",
          passed: true,
          evidence: {
            toolCalls: counter,
            descendants: { helpers: counter, commands: counter },
          },
        },
        { name: "product-tool-round-trip", passed: true, evidence: {} },
        {
          name: "dependency-manifest",
          passed: true,
          evidence: { missingPackages: [], missingBytes: 0 },
        },
      ],
    };
    expect(
      assessContainerCohort({
        approval: "approved",
        report,
        routeContext: 64000,
        architectureMaximum: 131072,
        servingContext: 64000,
      }),
    ).toMatchObject({ ready: true, failures: [], gates: { contextPin: true } });
    for (const servingContext of [null, 32768, 131072])
      expect(
        assessContainerCohort({
          approval: "approved",
          report,
          routeContext: 64000,
          architectureMaximum: 131072,
          servingContext,
        }).ready,
      ).toBe(false);
  });
  it("parses recorded serving-state fixtures without loading a model", () => {
    const tag = { name: expected.model, digest: expected.digest };
    expect(
      parseServingContext(
        { models: [{ ...tag, context_length: 64000, size_vram: 1234 }] },
        expected,
      ),
    ).toBe(64000);
    for (const value of [
      { models: [] },
      { models: [{ ...tag, digest: contentDigest("other"), context_length: 64000 }] },
      { models: [{ ...tag, context_length: 0 }] },
      {
        models: [
          { ...tag, context_length: 64000 },
          { ...tag, context_length: 64000 },
        ],
      },
    ])
      expect(() => parseServingContext(value, expected)).toThrow();
  });
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
      "/api/ps",
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
      effectiveContext: 64000,
      generationRequests: 0,
    });
    expect(result.budget.contextSize).toBe(64000);
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
  it.each([undefined, null, false, true, 0, [], {}, "", " ", "0.1\n", "0/1", "v".repeat(81)])(
    "rejects an unobserved or invalid server version %j before model details",
    async (version) => {
      const f = fixture();
      f.responses[1] = { version };
      f.responses[5] = { version };
      await expect(inspectLocalRoute(expected, f.transport)).rejects.toThrow("serverVersion");
      expect(f.requests.map(({ url }) => new URL(url).pathname)).toEqual([
        "/api/tags",
        "/api/version",
      ]);
    },
  );
  it.each(["0.0.0-test", "v1.2.3_rc-1", "v".repeat(80)])(
    "retains the exact permitted version %s and requires its recheck to match",
    async (version) => {
      const f = fixture();
      f.responses[1] = { version };
      f.responses[5] = { version };
      expect((await inspectLocalRoute(expected, f.transport)).budget.model.serverVersion).toBe(
        version,
      );
      const changed = fixture();
      changed.responses[1] = { version };
      changed.responses[5] = { version: null };
      await expect(inspectLocalRoute(expected, changed.transport)).rejects.toThrow("version drift");
    },
  );
  it.each(["quantization", "context", "tokenizer", "tag-race", "server-race"])(
    "refuses %s without inventing a route pin",
    async (change) => {
      const f = fixture();
      if (change === "quantization") f.show.details.quantization_level = "Q8";
      if (change === "context") f.show.model_info["qwen3.context_length"] = 4096;
      if (change === "tokenizer") f.show.model_info["tokenizer.ggml.tokens"] = [];
      if (change === "tag-race") f.responses[4] = { models: [] };
      if (change === "server-race") f.responses[5] = { version: "changed" };
      await expect(inspectLocalRoute(expected, f.transport)).rejects.toThrow();
      expect(f.requests.length).toBeLessThanOrEqual(6);
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
