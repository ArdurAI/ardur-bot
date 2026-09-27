import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentRuntimeEvent, UsageOutcome } from "@ardurbot/adapter-kit";
import { RequestUsageCollector, usageEvent } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import { RuntimePinError, runtimePinProblem } from "@ardurbot/contracts";

/** Stderr is diagnostic only. Keep no untrusted diagnostic text after classification. */
export class AntigravityDiagnostics {
  private prefix = "";
  private bytes = 0;
  agyError = false;
  feed(chunk: Buffer | string) {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > 16 * 1024) return;
    for (const character of chunk.toString()) {
      if (character === "\n") {
        if (this.prefix === "AGY_ERROR") this.agyError = true;
        this.prefix = "";
      } else if (this.prefix.length < 9) this.prefix += character;
    }
  }
}

export async function* antigravityLines(
  child: ChildProcessWithoutNullStreams,
): AsyncIterable<Record<string, unknown>> {
  let pending = "";
  let total = 0;
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    total += Buffer.byteLength(chunk);
    if (total > 8 * 1024 * 1024) throw new Error("Runtime output exceeded its limit.");
    pending += chunk;
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (Buffer.byteLength(line) > 256 * 1024 || !line.trim())
        throw new Error("Invalid runtime event.");
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid runtime event.");
      yield value as Record<string, unknown>;
      index = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending) > 256 * 1024)
      throw new Error("Runtime output exceeded its limit.");
  }
  if (pending) throw new Error("Incomplete runtime event.");
}

export class AntigravityStreamParser {
  initialized = false;
  finished = false;
  authError = false;
  sessionId?: string;
  private readonly usage: RequestUsageCollector;
  private usageFinished = false;
  private textBytes = 0;
  constructor(private readonly pin: RuntimePin) {
    this.usage = new RequestUsageCollector({
      provider: "antigravity",
      model: pin.modelId!,
      mappingVersion: "antigravity-1.2.12-v1",
      scope: "native-turn",
      inputSemantics: "total-with-cache-subsets",
      reasoningSemantics: "subset-of-output",
      limitations: ["native-request-detail-unavailable"],
    });
  }
  startUsage() {
    return usageEvent(this.usage.start());
  }
  finishUsage(outcome: Exclude<UsageOutcome, "started">) {
    if (this.usageFinished) return [];
    this.usageFinished = true;
    return [usageEvent(this.usage.finish(outcome))];
  }
  parse(value: Record<string, unknown>): AgentRuntimeEvent[] {
    if (this.finished)
      throw this.failure(
        "runtime-unavailable",
        "Antigravity returned an invalid response.",
        "invalid-response",
      );
    if (value.event === "init") {
      if (this.initialized || !value.init || typeof value.init !== "object")
        throw this.failure(
          "runtime-unavailable",
          "Antigravity returned an invalid response.",
          "invalid-response",
        );
      const init = value.init as Record<string, unknown>;
      if (init.model !== this.pin.modelId)
        throw this.failure(
          "pin-model-unknown",
          `Antigravity did not recognise the model ${this.pin.modelId}. Pick a model from its list.`,
          "model-unrecognised",
        );
      this.initialized = true;
      this.sessionId =
        typeof value.conversation_id === "string" ? value.conversation_id : undefined;
      return [];
    }
    if (value.event === "step_update") {
      if (!this.initialized || !value.step_update || typeof value.step_update !== "object")
        throw this.failure(
          "runtime-unavailable",
          "Antigravity returned an invalid response.",
          "invalid-response",
        );
      const step = value.step_update as Record<string, unknown>;
      if (step.step_type === "tool")
        throw this.failure(
          "runtime-unavailable",
          "Antigravity tried to use its own tools, which Ardur does not allow yet. The turn was stopped.",
          "native-tool-attempted",
        );
      if (step.step_type === "agent_response") {
        if (step.text_delta === undefined) return [];
        if (typeof step.text_delta !== "string")
          throw this.failure(
            "runtime-unavailable",
            "Antigravity returned an invalid response.",
            "invalid-response",
          );
        this.textBytes += Buffer.byteLength(step.text_delta);
        if (this.textBytes > 4 * 1024 * 1024)
          throw this.failure(
            "runtime-unavailable",
            "Antigravity returned too much text.",
            "text-too-large",
          );
        return [{ type: "text", text: step.text_delta }];
      }
      if (step.step_type === "user_input") return [];
      throw this.failure(
        "runtime-unavailable",
        "Antigravity returned an invalid response.",
        "invalid-response",
      );
    }
    if (value.event === "result") {
      if (!value.result || typeof value.result !== "object")
        throw this.failure(
          "runtime-unavailable",
          "Antigravity returned an invalid response.",
          "invalid-response",
        );
      const result = value.result as Record<string, unknown>;
      this.recordUsage(result.usage);
      if (result.status === "ERROR") {
        const error = typeof result.error === "string" ? result.error : "";
        if (/invalid model selection|model .*not recognized/i.test(error))
          throw this.failure(
            "pin-model-unknown",
            `Antigravity did not recognise the model ${this.pin.modelId}. Pick a model from its list.`,
            "model-unrecognised",
          );
        if (/authentication required|not signed in|sign in required/i.test(error))
          this.authError = true;
        throw this.failure(
          "runtime-unavailable",
          "Antigravity could not run this turn: the runtime reported an error.",
          this.authError ? "signed-out" : "runtime-error",
        );
      }
      if (!this.initialized)
        throw this.failure(
          "runtime-unavailable",
          "Antigravity returned an invalid response.",
          "invalid-response",
        );
      if (
        result.status !== "SUCCESS" ||
        (result.denied_actions !== undefined &&
          (!Array.isArray(result.denied_actions) || result.denied_actions.length > 0))
      )
        throw this.failure(
          "runtime-unavailable",
          "Antigravity tried to use its own tools, which Ardur does not allow yet. The turn was stopped.",
          "native-tool-attempted",
        );
      if (typeof result.response !== "string" || !result.response || this.textBytes === 0)
        throw this.failure(
          "runtime-unavailable",
          "Antigravity returned an empty response.",
          "empty-response",
        );
      this.finished = true;
      return [];
    }
    throw this.failure(
      "runtime-unavailable",
      "Antigravity returned an invalid response.",
      "invalid-response",
    );
  }
  private recordUsage(observation: unknown) {
    if (
      observation !== undefined &&
      (!observation || typeof observation !== "object" || Array.isArray(observation))
    )
      throw this.failure(
        "runtime-unavailable",
        "Antigravity returned invalid usage.",
        "invalid-response",
      );
    if (observation && typeof observation === "object") {
      const usage = observation as Record<string, unknown>;
      if (
        ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens"].some(
          (key) =>
            usage[key] !== undefined &&
            (typeof usage[key] !== "number" ||
              !Number.isSafeInteger(usage[key]) ||
              (usage[key] as number) < 0),
        ) ||
        (typeof usage.thinking_tokens === "number" &&
          typeof usage.output_tokens === "number" &&
          usage.thinking_tokens > usage.output_tokens) ||
        (typeof usage.cache_read_tokens === "number" &&
          typeof usage.input_tokens === "number" &&
          usage.cache_read_tokens > usage.input_tokens)
      )
        throw this.failure(
          "runtime-unavailable",
          "Antigravity returned invalid usage.",
          "invalid-response",
        );
      this.usage.snapshot({
        input: usage.input_tokens,
        output: usage.output_tokens,
        reasoning: usage.thinking_tokens,
        cacheRead: usage.cache_read_tokens,
      });
    }
  }
  private failure(
    code: "runtime-unavailable" | "pin-model-unknown",
    reason: string,
    reasonId: string,
  ) {
    return new RuntimePinError(runtimePinProblem(this.pin, code, reason, reasonId));
  }
}
