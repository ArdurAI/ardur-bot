import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@ardurbot/adapter-kit";
import { validateHermesExecutionEnvelope } from "@ardurbot/core/node/runtime-config-hash";
import { guardrailConfigFromEnv } from "@ardurbot/host-runtime/host-guardrails";
import {
  buildHermesRuntime,
  localHermesStaging,
} from "@ardurbot/host-runtime/runtimes/hermes-install";
import type { HermesProviderFailure } from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";
import { startHermesProviderRelay } from "@ardurbot/host-runtime/runtimes/hermes-provider-relay";
import type { HermesRuntime } from "@ardurbot/host-runtime/runtimes/hermes-runtime";
import type { BrokerScope, HermesProviderBroker } from "../hermes-provider-broker.js";
import {
  HermesRelayDispatcher,
  summaryOperationHash,
  summaryOperationManifest,
} from "../hermes-provider-broker.js";
import { buildHostTurn } from "../host-turn.js";

export class LocalHermesRuntime implements AgentRuntime {
  private running = new Map<string, HermesRuntime>();

  constructor(
    private readonly brokerForTurn?: (
      request: AgentRunRequest,
      context: Partial<AdapterContext>,
      fence: { operationId: string; hostGeneration: string },
    ) => Promise<{ broker: HermesProviderBroker; scope: BrokerScope }>,
  ) {}

  describe() {
    return {
      id: "hermes",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: false,
        tools: true,
        scripted: false,
        usageAccounting: "external" as const,
      },
    };
  }

  async abort(runId: string) {
    await this.running.get(runId)?.abort(runId);
  }

  async fail(runId: string, failure?: HermesProviderFailure) {
    await this.running.get(runId)?.fail(runId, failure);
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const staging = localHermesStaging();
    const install = process.env.ARDUR_HERMES_INSTALL;

    let profileAcknowledged = false;

    const capturedPin = request.model.runtimePin as
      | (NonNullable<AgentRunRequest["model"]["runtimePin"]> & {
          effectiveRuntimeConfig?: unknown;
          effectiveRuntimeConfigHash?: unknown;
        })
      | undefined;
    let executionEnvelope =
      (capturedPin?.runtimeConfig as { version?: number } | undefined)?.version === 2
        ? validateHermesExecutionEnvelope({
            runtimeKind: "hermes",
            runtimeConfig: capturedPin?.runtimeConfig,
            runtimeConfigHash: capturedPin?.runtimeConfigHash,
            effectiveRuntimeConfig: capturedPin?.effectiveRuntimeConfig,
            effectiveRuntimeConfigHash: capturedPin?.effectiveRuntimeConfigHash,
          })
        : undefined;

    const operationHash =
      request.providerPurpose === "summary" &&
      request.providerSourceRunId &&
      request.providerSourceRunId !== request.runId
        ? summaryOperationHash(
            summaryOperationManifest(capturedPin!, request.model.maxTokens ?? 4_096),
          )
        : undefined;
    if (executionEnvelope && operationHash) {
      const { compileHermesRuntimeConfig } = await import(
        "@ardurbot/host-runtime/runtimes/hermes-config"
      );
      const { effectiveRuntimeConfigHash } = await import(
        "@ardurbot/core/node/runtime-config-hash"
      );
      const compiled = compileHermesRuntimeConfig(executionEnvelope.runtimeConfig, {
        id: request.model.id,
        contextWindow: request.model.contextWindow ?? 32_768,
        maxTokens: request.model.maxTokens ?? 4_096,
        reasoning: request.model.reasoning ?? false,
        acceptsImages: request.model.acceptsImages ?? false,
        thinkingLevel: request.model.thinkingLevel ?? "off",
      });
      executionEnvelope = validateHermesExecutionEnvelope({
        ...executionEnvelope,
        effectiveRuntimeConfig: compiled.manifest,
        effectiveRuntimeConfigHash: effectiveRuntimeConfigHash(compiled.manifest),
      });
    }

    let relay: Awaited<ReturnType<typeof startHermesProviderRelay>> | undefined;
    let brokerSession: { broker: HermesProviderBroker; scope: BrokerScope } | undefined;
    const assertProfileAcknowledged = () => {
      if (executionEnvelope && !profileAcknowledged)
        throw new Error("Hermes configuration is not acknowledged.");
    };
    try {
      const runtime = await buildHermesRuntime({
        hostRoot: staging,
        explicitInstall: install,
        bundleFile: process.argv[1] ?? "",
        moduleUrl: import.meta.url,
        guard: guardrailConfigFromEnv(),
        executionEnvelope,
        onProfileAcknowledged: () => {
          profileAcknowledged = true;
        },
        onTurnFinished: () => relay?.close(),
      });

      if (!runtime) throw new Error("Pinned Hermes install is unavailable.");

      const operationId = randomUUID();
      brokerSession = this.brokerForTurn
        ? await this.brokerForTurn(request, context ?? {}, {
            operationId,
            hostGeneration: "local",
          })
        : undefined;

      if (!brokerSession) throw new Error("Hermes needs a provider broker.");

      const relayDispatcher = new HermesRelayDispatcher(
        brokerSession,
        context?.signal ?? new AbortController().signal,
      );

      relay = await startHermesProviderRelay(
        { protocol: 1, ...brokerSession.broker.grant, hostGeneration: "local" },
        async (method, args) => {
          if (method === "provider.open" || method === "provider.read") assertProfileAcknowledged();
          const result = await relayDispatcher.dispatch(method, args);
          if (
            method === "provider.read" &&
            result &&
            typeof result === "object" &&
            "done" in result &&
            result.done
          )
            await request.saveCheckpoint?.(undefined);
          return result;
        },
        (failure) => {
          void this.fail(request.runId, failure).catch(() => {});
        },
      );

      this.running.set(request.runId, runtime);
      const authorizeTool = request.authorizeTool;
      const executeTool = request.executeTool;
      const onToolCompleted = request.onToolCompleted;
      const turn = buildHostTurn({
        kind: "hermes",
        request,
        executionEnvelope,
        operationHash,
        providerBriefAttemptedAt: brokerSession.scope.briefAttemptedAt,
      });
      const localRequest: AgentRunRequest = {
        ...turn,
        currentTurnImages: turn.currentTurnImages?.map((image) => ({
          ...image,
          data: Buffer.from(image.data, "base64"),
        })),
        model: {
          runtimePin: turn.model.runtimePin as AgentRunRequest["model"]["runtimePin"],
          provider: turn.model.provider,
          id: turn.model.id,
          baseUrl: relay.url,
          apiKey: brokerSession.broker.grant.token,
          maxTokens: turn.model.maxTokens,
          contextWindow: turn.model.contextWindow,
          acceptsImages: turn.model.acceptsImages,
          reasoning: turn.model.reasoning,
          thinkingLevel: turn.model.thinkingLevel,
        },
        tools: turn.tools as AgentRunRequest["tools"],
        authorizeTool: authorizeTool
          ? async (name) => {
              assertProfileAcknowledged();
              return authorizeTool(name);
            }
          : undefined,
        executeTool: executeTool
          ? async (name, args, executionId) => {
              assertProfileAcknowledged();
              const tool =
                request.tools === "none"
                  ? undefined
                  : request.tools.find((entry) => entry.name === name);
              return executeTool(name, args, executionId, tool?.route);
            }
          : undefined,
        onToolCompleted: onToolCompleted
          ? async (result) => {
              assertProfileAcknowledged();
              await onToolCompleted({
                ...result,
                error: result.error ? "Tool failed." : undefined,
              });
            }
          : undefined,
        onRuntimeInfo: request.onRuntimeInfo,
        acknowledgeInput: request.acknowledgeInput,
        claimSteering: request.claimSteering,
        saveCheckpoint: request.saveCheckpoint,
      };
      yield* runtime.run(localRequest, context);
    } finally {
      this.running.delete(request.runId);
      relay?.close();
      brokerSession?.broker.revoke();
    }
  }
}
