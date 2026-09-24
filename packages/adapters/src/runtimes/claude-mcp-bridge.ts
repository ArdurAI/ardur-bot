import { randomUUID } from "node:crypto";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolExecutionResult,
} from "@ardurbot/adapter-kit";
import { isToolPauseResult } from "../approval-effect.js";

/** The bridge owns no effects: the executor owns approval, routing, replay and auditing. */
export function createArdurToolBridge(
  request: AgentRunRequest,
  emit: (event: AgentRuntimeEvent) => void,
  pause: () => void,
  ready: () => boolean = () => true,
) {
  const tools = request.tools === "none" ? [] : request.tools;
  let stopped = false;
  let tail = Promise.resolve();
  return {
    tools: tools.filter((tool) => tool.name !== "run_subagent"),
    async call(name: string, args: Record<string, unknown>) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const executionId = `${request.runId}:${randomUUID()}`;
      const started = Date.now();
      let result: unknown;
      let failure: unknown;
      let paused = false;
      let attempted = false;
      try {
        if (stopped) throw new Error("This run is waiting for approval.");
        if (!ready()) throw new Error("The pinned runtime is not ready.");
        const tool = tools.find((entry) => entry.name === name && name !== "run_subagent");
        if (!tool || !request.executeTool) throw new Error("This tool is unavailable in this run.");
        attempted = true;
        const authorization = await request.authorizeTool?.(name);
        if (!ready()) throw new Error("The pinned runtime is not ready.");
        if (!authorization && (name === "ask_user" || name === "request_takeover")) {
          if (name === "ask_user") {
            const options = Array.isArray(args.options) ? args.options.map(String) : [];
            if (
              options.length < 2 ||
              options.length > 4 ||
              options.some((value) => !value.trim() || value.length > 80) ||
              new Set(options).size !== options.length
            )
              throw new Error("Choose two to four distinct options.");
            emit({
              type: "ask",
              text: String(args.question ?? "What should I use?"),
              actions: options.map((label, index) => ({ id: `choice-${index + 1}`, label })),
            });
          } else
            emit({ type: "takeover", reason: String(args.reason ?? "I need you on the screen.") });
          stopped = true;
          paused = true;
          pause();
          throw new Error("Waiting for your input.");
        }
        result = authorization ?? (await request.executeTool(name, args, executionId, tool.route));
        paused = isToolPauseResult(result);
        emit({ type: "tool", name, args, executionId });
        if (paused) {
          stopped = true;
          pause();
          throw new Error("Waiting for approval. No effect was performed.");
        }
        if (
          result &&
          typeof result === "object" &&
          "kind" in result &&
          result.kind === "agent_tool_result"
        )
          return { content: (result as AgentToolExecutionResult).content };
        return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        if (!paused) failure = error;
        throw error;
      } finally {
        if (attempted) {
          try {
            await request.onToolCompleted?.({
              name,
              executionId,
              result,
              error: failure,
              paused,
              durationMs: Date.now() - started,
            });
          } catch {
            // Match Pi: a failed audit append must not replay an effect.
          }
        }
        release();
      }
    },
  };
}
