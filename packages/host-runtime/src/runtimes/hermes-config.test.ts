import {
  HERMES_RUNTIME_V2_DEFAULTS,
  RuntimeConfigExecutionManifestSchema,
} from "@ardurbot/contracts/runtime-config";
import {
  effectiveRuntimeConfigHash,
  runtimeConfigV2Hash,
  validateHermesExecutionEnvelope,
} from "@ardurbot/core/node/runtime-config-hash";
import { describe, expect, it } from "vitest";
import { compileHermesRuntimeConfig } from "./hermes-config.js";

const model = {
  id: "fixture-model",
  contextWindow: 32_768,
  maxTokens: 4_096,
  reasoning: true,
  acceptsImages: false,
  thinkingLevel: "medium" as const,
};

describe("Hermes managed configuration compiler", () => {
  it("produces deterministic settings, fixed policy and a nonsecret preview", () => {
    const first = compileHermesRuntimeConfig(HERMES_RUNTIME_V2_DEFAULTS, model);
    expect(compileHermesRuntimeConfig(HERMES_RUNTIME_V2_DEFAULTS, model)).toEqual(first);
    expect(RuntimeConfigExecutionManifestSchema.parse(first.manifest)).toEqual(first.manifest);
    const native = JSON.parse(first.configYaml);
    expect(native.agent).toMatchObject({
      api_max_retries: 1,
      max_turns: 16,
      run_budget_seconds: 180,
    });
    expect(native.context_file_max_chars).toBe(16_384);
    expect(native.compression).toMatchObject({
      enabled: false,
      micro_compact: false,
      proactive_prune_tokens: 0,
      idle_compact_after_seconds: 0,
    });
    expect(native).toMatchObject({
      custom_providers: [],
      fallback_providers: [],
      toolsets: [],
      mcp_servers: {},
    });
    expect(first.launcher).toEqual({
      model: "fixture-model",
      maxIterations: 16,
      runBudgetSeconds: 180,
      contextFileMaxChars: 16_384,
      apiMaxRetries: 1,
    });
    expect(JSON.stringify(first.preview)).not.toMatch(/base_url|api_key|endpoint|\/private\//);
  });

  it("routes each tunable field to its intended output or manifest", () => {
    const changed = compileHermesRuntimeConfig(
      {
        ...HERMES_RUNTIME_V2_DEFAULTS,
        limits: { maxProviderRequests: 3, timeoutMs: 10_000 },
        context: { maxInputBytes: 8_192, overflow: "stop" },
        harness: { agent: { api_max_retries: 3 } },
      },
      model,
    );
    const native = JSON.parse(changed.configYaml);
    expect(native.agent).toMatchObject({
      max_turns: 3,
      run_budget_seconds: 10,
      api_max_retries: 3,
    });
    expect(native.context_file_max_chars).toBe(8_192);
    expect(changed.launcher.maxIterations).toBe(3);
    expect(changed.manifest.settings.context.overflow).toBe("stop");
  });

  it("does not propagate unrecognized model input into generated files or preview", () => {
    const tainted = { ...model, apiKey: "fake-secret-marker", baseUrl: "http://private.invalid" };
    const output = compileHermesRuntimeConfig(HERMES_RUNTIME_V2_DEFAULTS, tainted);
    expect(JSON.stringify(output)).not.toContain("fake-secret-marker");
    expect(JSON.stringify(output)).not.toContain("private.invalid");
    expect(() =>
      compileHermesRuntimeConfig(HERMES_RUNTIME_V2_DEFAULTS, { ...model, maxTokens: Infinity }),
    ).toThrow();
  });

  it("rejects a captured envelope when settings or effective identity differ", () => {
    const compiled = compileHermesRuntimeConfig(HERMES_RUNTIME_V2_DEFAULTS, model);
    const envelope = {
      runtimeKind: "hermes",
      runtimeConfig: HERMES_RUNTIME_V2_DEFAULTS,
      runtimeConfigHash: runtimeConfigV2Hash(HERMES_RUNTIME_V2_DEFAULTS),
      effectiveRuntimeConfig: compiled.manifest,
      effectiveRuntimeConfigHash: effectiveRuntimeConfigHash(compiled.manifest),
    };
    expect(validateHermesExecutionEnvelope(envelope).effectiveRuntimeConfig).toEqual(
      compiled.manifest,
    );
    expect(() =>
      validateHermesExecutionEnvelope({ ...envelope, runtimeConfigHash: "0".repeat(64) }),
    ).toThrow();
    expect(() =>
      validateHermesExecutionEnvelope({
        ...envelope,
        runtimeConfig: {
          ...HERMES_RUNTIME_V2_DEFAULTS,
          context: { ...HERMES_RUNTIME_V2_DEFAULTS.context, overflow: "stop" },
        },
      }),
    ).toThrow();
  });
});
