import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolCompletion,
} from "@ardurbot/adapter-kit";
import {
  HostRuntimeEventSchema,
  HostRuntimeInfoSchema,
  HostTurnSchema,
} from "@ardurbot/contracts/host-bridge";
import type { RuntimeInfoSchema } from "@ardurbot/contracts/runtime-pins";
import type { HostClient } from "@ardurbot/host-runtime/host-client";
import * as z from "zod";
import type { BrokerScope, HermesProviderBroker } from "./hermes-provider-broker.js";

/** The host turn receives the same tool catalog the executor selected, including board tools. */
export function advertisedHostTools(tools: AgentRunRequest["tools"]) {
  if (tools === "none") return "none" as const;
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export class RemoteHostRuntime implements AgentRuntime {
  private active = new Map<string, AbortController>();
  constructor(
    private readonly client: HostClient,
    private readonly kind: "claude-code" | "codex-app-server" | "antigravity" | "hermes",
    private readonly brokerForTurn?: (
      request: AgentRunRequest,
      context: Partial<AdapterContext>,
      fence: { operationId: string; hostGeneration: string },
    ) => Promise<{ broker: HermesProviderBroker; scope: BrokerScope }>,
  ) {}
  describe() {
    return {
      id: this.kind,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: false,
        tools: this.kind !== "antigravity",
        scripted: false,
        ...(this.kind === "hermes" ? { usageAccounting: "external" as const } : {}),
      },
    };
  }
  async abort(runId: string) {
    this.active.get(runId)?.abort();
  }
  async *run(
    request: AgentRunRequest,
    context: Partial<AdapterContext> = {},
  ): AsyncIterable<AgentRuntimeEvent> {
    if (request.model.apiKey || request.model.oauth)
      throw new Error("Native host runtimes use their own sign-in.");
    const health = this.kind === "hermes" ? await this.client.health() : null;
    if (this.kind === "hermes") {
      if (!this.brokerForTurn || health?.capabilities?.providerRelay !== 1 || !health.generation)
        throw new Error("This host cannot run the pinned provider relay.");
    }
    const operationId = randomUUID();
    const brokerSession =
      this.kind === "hermes"
        ? await this.brokerForTurn?.(request, context, {
            operationId,
            hostGeneration: health!.generation!,
          })
        : undefined;
    if (brokerSession) {
      const { scope } = brokerSession;
      const generationFence = createHash("sha256")
        .update(health!.generation!)
        .digest()
        .readUIntBE(0, 6);
      const pin = request.model.runtimePin;
      if (
        scope.operationId !== operationId ||
        scope.hostGeneration !== generationFence ||
        scope.runId !== request.runId ||
        scope.botId !== request.botId ||
        scope.userId !== context.userId ||
        scope.spaceId !== context.spaceId ||
        scope.pin.credentialId !== pin?.credentialId ||
        scope.pin.provider !== request.model.provider ||
        scope.pin.modelId !== request.model.id ||
        scope.pin.effort !== request.model.thinkingLevel
      ) {
        brokerSession.broker.revoke();
        throw new Error("Provider broker scope does not match this host turn.");
      }
    }
    let response: Buffer | undefined;
    let responseStatus = 200;
    let responseType: "application/json" | "text/event-stream" = "application/json";
    let readSequence = 0;
    let opening = false;
    const abort = new AbortController();
    const stop = () => abort.abort();
    const homeKey = request.nativeCwd?.startsWith("host:")
      ? request.nativeCwd.slice(5)
      : request.botId;
    let turn: ReturnType<typeof HostTurnSchema.parse>;
    try {
      turn = HostTurnSchema.parse({
        providerBroker: brokerSession
          ? { protocol: 1, ...brokerSession.broker.grant, hostGeneration: health!.generation }
          : undefined,
        controlledComparison: request.controlledComparison,
        botId: request.botId,
        threadId: request.threadId,
        runId: request.runId,
        prompt: request.prompt,
        instructions: request.instructions,
        history: request.history,
        nativeSession: request.nativeSession,
        nativeCwd: request.nativeCwd?.startsWith("host:") ? undefined : request.nativeCwd,
        sourceMessageId: request.sourceMessageId,
        tools: advertisedHostTools(request.tools),
        model: {
          runtimePin: request.model.runtimePin,
          provider: request.model.provider,
          id: request.model.id,
          maxTokens: request.model.maxTokens,
          contextWindow: request.model.contextWindow,
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
    } catch (error) {
      brokerSession?.broker.revoke();
      throw error;
    }
    this.active.set(request.runId, abort);
    context.signal?.addEventListener("abort", stop, { once: true });
    if (context.signal?.aborted) stop();
    const tools = request.tools === "none" ? [] : request.tools;
    const executions = new Map<string, { name: string; result?: unknown; error?: unknown }>();
    const seenExecutions = new Set<string>();
    const authorizations = new Map<string, unknown>();
    try {
      for await (const frame of this.client.request(
        { op: "runtime.turn", homeKey, request: turn },
        { ...context, botId: request.botId, runId: request.runId, signal: abort.signal },
        async (frame) => {
          abort.signal.throwIfAborted();
          if (frame.method.startsWith("provider.")) {
            if (!brokerSession) throw new Error("Provider callback is unavailable.");
            if (frame.method === "provider.cancel") {
              if (opening) brokerSession.broker.revoke();
              response = undefined;
              return;
            }
            if (frame.method === "provider.open") {
              if (opening || response) throw new Error("Provider request is already active.");
              opening = true;
              try {
                const opened = await brokerSession.broker.open({
                  grant: brokerSession.broker.grant,
                  scope: brokerSession.scope,
                  path: "/v1/chat/completions",
                  body: frame.args[0],
                  signal: abort.signal,
                });
                if (!opened.ok) throw new Error("Provider request failed.");
                responseStatus = opened.status;
                responseType = opened.headers.get("content-type")?.includes("text/event-stream")
                  ? "text/event-stream"
                  : "application/json";
                response = Buffer.from(await opened.arrayBuffer());
                readSequence = 0;
                return { status: responseStatus, contentType: responseType };
              } finally {
                opening = false;
              }
            }
            if (!response || frame.args[0] !== readSequence)
              throw new Error("Provider response sequence changed.");
            const chunk = response.subarray(
              readSequence * 24 * 1024,
              (readSequence + 1) * 24 * 1024,
            );
            const done = (readSequence + 1) * 24 * 1024 >= response.length;
            const seq = readSequence++;
            if (done) response = undefined;
            return { seq, chunk: chunk.toString("base64"), done };
          }
          if (frame.method === "onRuntimeInfo") {
            await request.onRuntimeInfo?.(
              HostRuntimeInfoSchema.parse(frame.args[0]) as ReturnType<
                typeof RuntimeInfoSchema.parse
              >,
            );
            return;
          }
          if (frame.method === "claimSteering")
            return (
              request.claimSteering?.(z.array(z.string()).max(1024).parse(frame.args[0])) ?? []
            );
          if (frame.method === "onToolCompleted") {
            const completion = z
              .object({
                executionId: z.string(),
                name: z.string(),
                paused: z.boolean().optional(),
                durationMs: z.number().nonnegative(),
              })
              .parse(frame.args[0]);
            let execution = executions.get(completion.executionId);
            if (!execution) {
              // Approval pauses and ask/takeover complete without executeTool. Record only
              // the worker's authorization result; never trust an effect result from the host.
              if (
                !completion.paused ||
                !authorizations.has(completion.name) ||
                !completion.executionId.startsWith(`${request.runId}:`) ||
                seenExecutions.has(completion.executionId)
              )
                return;
              seenExecutions.add(completion.executionId);
              execution = { name: completion.name, result: authorizations.get(completion.name) };
            }
            if (execution.name !== completion.name) return;
            executions.delete(completion.executionId);
            authorizations.delete(completion.name);
            await request.onToolCompleted?.({ ...completion, ...execution } as AgentToolCompletion);
            return;
          }
          const name = z.string().parse(frame.args[0]);
          const tool = tools.find((entry) => entry.name === name && name !== "run_subagent");
          if (!tool) throw new Error("Tool is unavailable in this run.");
          if (frame.method === "authorizeTool") {
            const result = await request.authorizeTool?.(name);
            authorizations.set(name, result);
            return result;
          }
          const args = z.record(z.string(), z.unknown()).parse(frame.args[1]);
          const executionId = z.string().max(256).parse(frame.args[2]);
          if (
            !executionId.startsWith(`${request.runId}:`) ||
            seenExecutions.has(executionId) ||
            seenExecutions.size >= 10_000
          )
            throw new Error("Invalid tool execution.");
          seenExecutions.add(executionId);
          const execution: { name: string; result?: unknown; error?: unknown } = { name };
          executions.set(executionId, execution);
          try {
            execution.result =
              (await request.authorizeTool?.(name)) ??
              (await request.executeTool?.(name, args, executionId, tool.route));
            return execution.result;
          } catch (error) {
            execution.error = error;
            throw error;
          }
        },
        operationId,
      )) {
        if (frame.channel !== "event") throw new Error("Unexpected runtime frame.");
        yield HostRuntimeEventSchema.parse(frame.data);
      }
    } finally {
      brokerSession?.broker.revoke();
      this.active.delete(request.runId);
      context.signal?.removeEventListener("abort", stop);
    }
  }
}
