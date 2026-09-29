import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import type { HostProviderGrant, HostTurn } from "@ardurbot/contracts/host-bridge";
import { HostTurnSchema } from "@ardurbot/contracts/host-bridge";
import type { HermesExecutionEnvelopeSchema } from "@ardurbot/contracts/runtime-config";
import type * as z from "zod";

/** The host turn receives the same tool catalog the executor selected, including board tools. */
export function advertisedHostTools(tools: AgentRunRequest["tools"]) {
  if (tools === "none") return "none" as const;
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Hermes's view of a turn, identical for the bridged host and the in-process runtime. */
export function buildHostTurn(options: {
  kind: "claude-code" | "codex-app-server" | "antigravity" | "hermes";
  request: AgentRunRequest;
  executionEnvelope?: z.infer<typeof HermesExecutionEnvelopeSchema>;
  operationHash?: string;
  providerBroker?: HostProviderGrant;
  providerBriefAttemptedAt?: string;
}): HostTurn {
  const { kind, request, executionEnvelope, operationHash } = options;
  return HostTurnSchema.parse({
    executionEnvelope,
    providerBroker: options.providerBroker,
    controlledComparison: request.controlledComparison,
    botId: request.botId,
    threadId: request.threadId,
    runId: request.runId,
    providerSourceRunId: request.providerSourceRunId,
    providerPurpose: request.providerPurpose === "summary" ? "summary" : undefined,
    providerBriefAttemptedAt: options.providerBriefAttemptedAt,
    prompt: request.prompt,
    instructions: request.instructions,
    history: request.history,
    nativeSession: request.nativeSession,
    nativeCwd: request.nativeCwd?.startsWith("host:") ? undefined : request.nativeCwd,
    sourceMessageId: request.sourceMessageId,
    tools: advertisedHostTools(request.tools),
    model: {
      runtimePin: executionEnvelope
        ? { ...request.model.runtimePin, runtimeConfig: undefined }
        : request.model.runtimePin,
      provider: request.model.provider,
      id: request.model.id,
      maxTokens:
        kind === "hermes"
          ? operationHash
            ? (request.model.maxTokens ?? 4_096)
            : (executionEnvelope?.effectiveRuntimeConfig.model.maxTokens ??
              request.model.maxTokens ??
              4_096)
          : request.model.maxTokens,
      contextWindow:
        kind === "hermes"
          ? (executionEnvelope?.effectiveRuntimeConfig.model.contextWindow ??
            request.model.contextWindow ??
            32_768)
          : request.model.contextWindow,
      acceptsImages: request.model.acceptsImages,
      reasoning: request.model.reasoning,
      thinkingLevel: request.model.thinkingLevel,
    },
    currentTurnImages: request.currentTurnImages?.map((image) => ({
      ...image,
      data: Buffer.from(image.data).toString("base64"),
    })),
    allowSilentEmpty: request.allowSilentEmpty,
    emptyResponseText: request.emptyResponseText,
  });
}
