import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import profileFixture from "../../host-runtime/python/tests/valid_profile.json" with {
  type: "json",
};
import { advertisedHostTools, buildHostTurn } from "./host-turn.js";

const pin = {
  runtimeKind: "hermes" as const,
  provider: "fixture",
  modelId: "fixture-model",
  effort: "high",
  credentialId: "credential",
  revision: 1,
  runtimeConfig: profileFixture.runtimeConfig,
  runtimeConfigHash: profileFixture.runtimeConfigHash,
  effectiveRuntimeConfig: profileFixture.effectiveRuntimeConfig,
  effectiveRuntimeConfigHash: profileFixture.effectiveRuntimeConfigHash,
} as unknown as AgentRunRequest["model"]["runtimePin"];

const request = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "hello",
  instructions: "",
  history: [],
  nativeCwd: "host:computer",
  model: {
    provider: "fixture",
    id: "fixture-model",
    thinkingLevel: "high",
    contextWindow: 4_096,
    maxTokens: 512,
    reasoning: true,
    acceptsImages: false,
    runtimePin: pin,
  },
  tools: [
    {
      name: "write_file",
      description: "Write",
      inputSchema: { type: "object" },
      route: { connectorId: "connector", toolName: "write" },
    },
  ],
  ...overrides,
});

describe("buildHostTurn", () => {
  it("limits the tools to the advertised catalog without routes", () => {
    const turn = buildHostTurn({
      kind: "hermes",
      request: request(),
      executionEnvelope: profileFixture as never,
    });
    expect(turn.tools).toEqual([
      { name: "write_file", description: "Write", inputSchema: { type: "object" } },
    ]);
    expect(JSON.stringify(turn.tools)).not.toContain("connectorId");
    expect(buildHostTurn({ kind: "hermes", request: request({ tools: "none" }) }).tools).toBe(
      "none",
    );
  });

  it("takes hermes model limits from the execution envelope", () => {
    const turn = buildHostTurn({
      kind: "hermes",
      request: request(),
      executionEnvelope: profileFixture as never,
    });
    expect(turn.model.maxTokens).toBe(profileFixture.effectiveRuntimeConfig.model.maxTokens);
    expect(turn.model.contextWindow).toBe(
      profileFixture.effectiveRuntimeConfig.model.contextWindow,
    );
    expect(turn.model.runtimePin.runtimeConfig).toBeUndefined();
    expect(turn.model.runtimePin.runtimeConfigHash).toBe(profileFixture.runtimeConfigHash);
  });

  it("keeps the request's bounded output limit for a summary operation", () => {
    const turn = buildHostTurn({
      kind: "hermes",
      request: request({
        runId: "summary",
        providerSourceRunId: "run",
        providerPurpose: "summary",
      }),
      executionEnvelope: profileFixture as never,
      operationHash: "0".repeat(64),
    });
    expect(turn.providerPurpose).toBe("summary");
    expect(turn.model.maxTokens).toBe(512);
    expect(turn.model.contextWindow).toBe(
      profileFixture.effectiveRuntimeConfig.model.contextWindow,
    );
  });

  it("passes model limits through for the other host runtimes", () => {
    const turn = buildHostTurn({ kind: "claude-code", request: request() });
    expect(turn.model.maxTokens).toBe(512);
    expect(turn.model.contextWindow).toBe(4_096);
    expect(turn.providerPurpose).toBeUndefined();
  });

  it("strips the host cwd prefix and maps the provider purpose", () => {
    expect(buildHostTurn({ kind: "hermes", request: request() }).nativeCwd).toBeUndefined();
    expect(
      buildHostTurn({ kind: "hermes", request: request({ nativeCwd: "/plain" }) }).nativeCwd,
    ).toBe("/plain");
    expect(
      buildHostTurn({ kind: "hermes", request: request({ providerPurpose: "main" }) })
        .providerPurpose,
    ).toBeUndefined();
  });
});

describe("advertisedHostTools", () => {
  it("maps the selected catalog and keeps none", () => {
    expect(advertisedHostTools("none")).toBe("none");
    expect(advertisedHostTools(request().tools)).toEqual([
      { name: "write_file", description: "Write", inputSchema: { type: "object" } },
    ]);
  });
});
