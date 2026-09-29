import { randomUUID } from "node:crypto";
import type { AdapterContext, AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { buildHermesRuntime, localHermesRoot, localHermesStaging } from "@ardurbot/host-runtime/runtimes/hermes-install";
import { startHermesProviderRelay } from "@ardurbot/host-runtime/runtimes/hermes-provider-relay";
import type { HermesRuntime } from "@ardurbot/host-runtime/runtimes/hermes-runtime";
import { HermesRelayDispatcher } from "../hermes-provider-broker.js";
import type { BrokerScope, HermesProviderBroker } from "../hermes-provider-broker.js";
import { validateHermesExecutionEnvelope } from "@ardurbot/core/node/runtime-config-hash";

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
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false, usageAccounting: "external" as const },
    };
  }

  async abort(runId: string) {
    await this.running.get(runId)?.abort(runId);
  }

  async fail(runId: string) {
    await this.running.get(runId)?.fail(runId);
  }

  async *run(request: AgentRunRequest, context?: Partial<AdapterContext>): AsyncIterable<AgentRuntimeEvent> {
    const root = localHermesRoot();
    const staging = localHermesStaging();
    const install = process.env.ARDUR_HERMES_INSTALL;

    const operationId = randomUUID();
    const brokerSession = this.brokerForTurn
      ? await this.brokerForTurn(request, context ?? {}, {
          operationId,
          hostGeneration: "local",
        })
      : undefined;

    if (!brokerSession) throw new Error("Hermes needs a provider broker.");

    const relayDispatcher = new HermesRelayDispatcher(brokerSession, context?.signal ?? new AbortController().signal);

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

    if (executionEnvelope) {
      const { compileHermesRuntimeConfig } = await import("@ardurbot/host-runtime/runtimes/hermes-config");
      const { effectiveRuntimeConfigHash } = await import("@ardurbot/core/node/runtime-config-hash");
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
    try {
      const runtime = await buildHermesRuntime({
        hostRoot: staging,
        explicitInstall: install,
        bundleFile: process.argv[1] ?? "",
        moduleUrl: import.meta.url,
        executionEnvelope,
        onProfileAcknowledged: () => {
          profileAcknowledged = true;
        },
        onTurnFinished: () => relay?.close(),
      });

      if (!runtime) throw new Error("Pinned Hermes install is unavailable.");

      relay = await startHermesProviderRelay(
        { protocol: 1, ...brokerSession.broker.grant, hostGeneration: "local" },
        (method, args) => relayDispatcher.dispatch(method, args),
        () => {
          void this.fail(request.runId);
        }
      );

      this.running.set(request.runId, runtime);
      const localRequest: AgentRunRequest = {
        ...request,
        model: {
          ...request.model,
          baseUrl: relay.url,
          apiKey: brokerSession.broker.grant.token,
        },
        onToolCompleted: request.onToolCompleted
          ? async (result) => {
              await request.onToolCompleted?.({
                ...result,
                error: result.error ? "Tool failed." : undefined,
              });
            }
          : undefined,
      };
      delete (localRequest.model as any).oauth;
      delete (localRequest.model as any).headers;
      yield* runtime.run(localRequest, context);
    } finally {
      this.running.delete(request.runId);
      relay?.close();
      brokerSession.broker.revoke();
    }
  }
}
