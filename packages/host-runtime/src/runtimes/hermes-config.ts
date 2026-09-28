import type {
  HermesRuntimeConfigV2,
  RuntimeConfigExecutionManifest,
} from "@ardurbot/contracts/runtime-config";
import {
  HERMES_CONFIG_ARTIFACT_VERSION,
  HERMES_MANAGED_PROFILE,
  HERMES_SOURCE_REVISION,
  HermesRuntimeConfigV2Schema,
  RuntimeConfigManagedProfileSchema,
} from "@ardurbot/contracts/runtime-config";
import { validateHermesExecutionEnvelope } from "@ardurbot/core/node/runtime-config-hash";
import { canonicalRuntimeJson } from "@ardurbot/core/runtime-config";

const NATIVE_TOOLSETS = [
  "web",
  "terminal",
  "process",
  "files",
  "browser",
  "vision",
  "skills",
  "todo",
  "memory",
  "session_search",
  "execute_code",
  "delegate_task",
  "cronjob",
] as const;

/** Nonsecret qualified connection capabilities; broker delivery is a managed binding. */
export interface HermesConfigModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  acceptsImages: boolean;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export const HERMES_MANAGED_PROFILE_IDENTITY = RuntimeConfigManagedProfileSchema.parse({
  format: 1,
  profile: HERMES_MANAGED_PROFILE,
  sourceRevision: HERMES_SOURCE_REVISION,
  artifactVersion: HERMES_CONFIG_ARTIFACT_VERSION,
});

export function compileHermesRuntimeConfig(
  document: HermesRuntimeConfigV2,
  model: HermesConfigModel,
) {
  const settings = HermesRuntimeConfigV2Schema.parse(document);
  if (
    !model.id ||
    !/^[\w./:-]{1,200}$/.test(model.id) ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow <= 0 ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens <= 0 ||
    model.maxTokens > 65_536 ||
    typeof model.reasoning !== "boolean" ||
    typeof model.acceptsImages !== "boolean" ||
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(model.thinkingLevel)
  )
    throw new Error("Qualified model capabilities are invalid.");

  const generatedConfig = {
    model: {
      default: model.id,
      provider: "custom",
      context_length: model.contextWindow,
      supports_vision: model.acceptsImages,
    },
    custom_providers: [],
    model_overrides:
      model.reasoning || model.acceptsImages
        ? {
            "custom:ardur": {
              [model.id]: {
                context_window: model.contextWindow,
                supports_reasoning: model.reasoning,
                supports_vision: model.acceptsImages,
                supports_tools: true,
              },
            },
          }
        : {},
    fallback_providers: [],
    toolsets: [],
    agent: {
      disabled_toolsets: [...NATIVE_TOOLSETS],
      reasoning_effort: model.thinkingLevel === "off" ? "none" : model.thinkingLevel,
      coding_context: "off",
      environment_probe: false,
      api_max_retries: settings.harness.agent.api_max_retries,
      max_turns: settings.limits.maxProviderRequests,
      run_budget_seconds: settings.limits.timeoutMs / 1_000,
    },
    context: { engine: "compressor" },
    context_file_max_chars: settings.context.maxInputBytes,
    compression: {
      enabled: false,
      micro_compact: false,
      proactive_prune_tokens: 0,
      idle_compact_after_seconds: 0,
      codex_app_server_auto: "off",
    },
    auxiliary: { background_review: { enabled: false }, title_generation: { enabled: false } },
    memory: { memory_enabled: false, user_profile_enabled: false },
    skills: { project_discovery: false, external_dirs: [], inline_shell: false },
    delegation: { max_iterations: 0 },
    cron: { allow_agent_scheduling: false },
    hooks: {},
    hooks_auto_accept: false,
    plugins: { enabled: [] },
    telemetry: { shared_metrics: { enabled: false } },
    security: { allow_lazy_installs: false },
    tools: { tool_search: { enabled: "off" } },
    mcp_servers: {},
  };
  const launcher = {
    model: model.id,
    maxIterations: settings.limits.maxProviderRequests,
    runBudgetSeconds: settings.limits.timeoutMs / 1_000,
    contextFileMaxChars: settings.context.maxInputBytes,
    apiMaxRetries: settings.harness.agent.api_max_retries,
  };
  const manifest = {
    format: 1,
    profile: HERMES_MANAGED_PROFILE_IDENTITY,
    runtimeKind: "hermes",
    settings,
    model: {
      id: model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      acceptsImages: model.acceptsImages,
      thinkingLevel: model.thinkingLevel,
    },
    generatedConfig,
    launcher,
    bindings: {
      credentials: "broker-grant",
      tools: "ardur-catalog",
      approvals: "ardur-policy",
      paths: "ephemeral-owned-home",
      network: "managed-relay",
    },
  } as const;
  return {
    configYaml: `${JSON.stringify(generatedConfig, null, 2)}\n`,
    launcher,
    manifest,
    preview: {
      settings,
      managed: {
        model: model.id,
        thinkingLevel: model.thinkingLevel,
        connection: "Ardur connection",
        credentials: "Broker binding",
        tools: "Ardur catalog",
        approvals: "Ardur policy",
        paths: "Ephemeral owned home",
        nativeChildren: false,
        nativeCompression: false,
      },
    },
  };
}

/** Recompilation checks policy as well as hashes; no supplied native key is trusted. */
export function validateCompiledHermesProfile(value: unknown, model: HermesConfigModel) {
  const envelope = validateHermesExecutionEnvelope(value);
  const expected = compileHermesRuntimeConfig(envelope.runtimeConfig, model);
  if (
    canonicalRuntimeJson(envelope.effectiveRuntimeConfig) !==
    canonicalRuntimeJson(expected.manifest as RuntimeConfigExecutionManifest)
  )
    throw new Error("Hermes configuration does not match the selected model and managed profile.");
  return { envelope, compiled: expected };
}
