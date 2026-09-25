import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolCompletion,
} from "@ardurbot/adapter-kit";
import { HostRuntimeEventSchema, HostTurnSchema } from "@ardurbot/contracts/host-bridge";
import { RuntimeInfoSchema } from "@ardurbot/contracts/runtime-pins";
import type { HostClient } from "@ardurbot/host-runtime/host-client";
import * as z from "zod";

/** The host turn receives the same tool catalog the executor selected, including board tools. */
export function advertisedHostTools(tools: AgentRunRequest["tools"]) {
  if (tools === "none") return "none" as const;
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export class RemoteHostRuntime implements AgentRuntime {
  private active = new Map<string, AbortController>();
  constructor(
    private readonly client: HostClient,
    private readonly kind: "claude-code" | "codex-app-server",
  ) {}
  describe() {
    return {
      id: this.kind,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
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
    const abort = new AbortController();
    this.active.set(request.runId, abort);
    const stop = () => abort.abort();
    context.signal?.addEventListener("abort", stop, { once: true });
    if (context.signal?.aborted) stop();
    const homeKey = request.nativeCwd?.startsWith("host:")
      ? request.nativeCwd.slice(5)
      : request.botId;
    const turn = HostTurnSchema.parse({
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
        thinkingLevel: request.model.thinkingLevel,
      },
      currentTurnImages: request.currentTurnImages?.map((image) => ({
        ...image,
        data: Buffer.from(image.data).toString("base64"),
      })),
      allowSilentEmpty: request.allowSilentEmpty,
      emptyResponseText: request.emptyResponseText,
    });
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
          if (frame.method === "onRuntimeInfo") {
            await request.onRuntimeInfo?.(RuntimeInfoSchema.parse(frame.args[0]));
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
      )) {
        if (frame.channel !== "event") throw new Error("Unexpected runtime frame.");
        yield HostRuntimeEventSchema.parse(frame.data);
      }
    } finally {
      this.active.delete(request.runId);
      context.signal?.removeEventListener("abort", stop);
    }
  }
}
