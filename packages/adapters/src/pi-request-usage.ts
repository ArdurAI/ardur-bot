import type { AgentUsage, RawUsageCounts, UsageOutcome, UsagePurpose } from "@ardurbot/adapter-kit";
import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@ardurbot/contracts";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { traceCurrent } from "./scoreboard-trace.js";
import { dispatcherFetch } from "./undici-fetch.js";

const HTTP_APIS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);
const MAX_USAGE_LINE_CHARS = 512 * 1024;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Read only documented usage fields. No prompt, response text, headers or request URL is retained. */
export function piWireUsage(
  api: string,
  payload: unknown,
): Partial<Record<keyof RawUsageCounts, unknown>> | null {
  const value = object(payload);
  if (api === "anthropic-messages") {
    const source = value.type === "message_start" ? object(value.message).usage : value.usage;
    if (!source || typeof source !== "object") return null;
    const usage = object(source);
    return {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cacheWrite1h: object(usage.cache_creation).ephemeral_1h_input_tokens,
      reasoning: object(usage.output_tokens_details).thinking_tokens,
    };
  }
  const source =
    api === "openai-completions"
      ? (value.usage ?? object(Array.isArray(value.choices) ? value.choices[0] : undefined).usage)
      : (object(value.response).usage ?? value.usage);
  if (!source || typeof source !== "object") return null;
  const usage = object(source);
  const chat = api === "openai-completions";
  const input = object(chat ? usage.prompt_tokens_details : usage.input_tokens_details);
  const output = object(chat ? usage.completion_tokens_details : usage.output_tokens_details);
  return {
    input: chat ? usage.prompt_tokens : usage.input_tokens,
    output: chat ? usage.completion_tokens : usage.output_tokens,
    cacheRead: input.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens,
    cacheWrite: input.cache_write_tokens,
    reasoning: output.reasoning_tokens,
    total: usage.total_tokens,
  };
}

/** A bounded pass-through observes bytes only as the SDK consumes them; it never tees the body. */
function observeBody(
  response: Response,
  onPayload: (payload: unknown) => void,
  oversized: () => void,
): Response {
  if (!response.body) return response;
  const sse = response.headers.get("content-type")?.includes("text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let skipping = false;
  const parse = (line: string) => {
    const data = sse ? (line.startsWith("data:") ? line.slice(5).trim() : "") : line.trim();
    if (!data || data === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    onPayload(payload);
  };
  const consume = (text: string) => {
    for (const part of text.split(/(?<=\n)/)) {
      if (!skipping) buffer += part;
      if (buffer.length > MAX_USAGE_LINE_CHARS) {
        buffer = "";
        skipping = true;
        oversized();
      }
      if (sse && part.endsWith("\n")) {
        if (!skipping) parse(buffer.trimEnd());
        buffer = "";
        skipping = false;
      }
    }
  };
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          consume(decoder.decode(chunk, { stream: true }));
          controller.enqueue(chunk);
        },
        flush() {
          consume(decoder.decode());
          if (!skipping && buffer) parse(buffer);
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

/** Preserve the SDK's retry/timeout policy while identifying each actual HTTP attempt. */
export function observePiUsage(
  model: Model<Api>,
  options: SimpleStreamOptions,
  start: (options: SimpleStreamOptions) => AssistantMessageEventStream,
  emit: (usage: AgentUsage) => void,
  attribution: { purpose?: UsagePurpose; parentRequestId?: string | null } = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const requestId = crypto.randomUUID();
  const supported = HTTP_APIS.has(model.api) && !options.transport?.startsWith("websocket");
  const semantics =
    model.api === "anthropic-messages" ? "additive-cache-categories" : "total-with-cache-subsets";
  let attempt = 0;
  let active:
    | {
        collector: RequestUsageCollector;
        counts: Partial<Record<keyof RawUsageCounts, unknown>>;
        finished: boolean;
        http: boolean;
        operationId: string;
        transport: boolean;
        text: boolean;
      }
    | undefined;
  const begin = (http: boolean) => {
    if (active && !active.finished) {
      if (active.http)
        traceCurrent("provider.finished", {
          requestId,
          operationId: active.operationId,
          outcome: "failed",
        });
      emit(active.collector.finish("failed"));
      active.finished = true;
    }
    const collector = new RequestUsageCollector({
      provider: model.provider,
      model: model.id,
      requestId,
      attemptId: String(attempt++),
      purpose:
        attempt > 1 && (attribution.purpose ?? "main") === "main"
          ? "retry"
          : (attribution.purpose ?? "main"),
      parentRequestId: attribution.parentRequestId,
      mappingVersion: http ? `pi-${model.api}-wire-v1` : "pi-normalized-v1",
      inputSemantics: http ? semantics : "total-with-cache-subsets",
      scope: http ? "request" : "runtime-call",
      limitations: http ? [] : ["transport-detail-unavailable"],
    });
    active = {
      collector,
      counts: {},
      finished: false,
      http,
      operationId: `${requestId}:${attempt - 1}`,
      transport: false,
      text: false,
    };
    if (http) traceCurrent("provider.started", { requestId, operationId: active.operationId });
    emit(collector.start());
    return active;
  };
  const finish = (outcome: Exclude<UsageOutcome, "started">) => {
    if (active && !active.finished) {
      if (active.http)
        traceCurrent("provider.finished", {
          requestId,
          operationId: active.operationId,
          outcome: outcome === "unknown" ? "uncertain" : outcome,
        });
      emit(active.collector.finish(outcome));
      active.finished = true;
    }
  };
  // These providers attach a package Undici Agent after the observer is injected.
  // Preserve their matching transport instead of falling back to Node's bundled fetch.
  const baseFetch =
    options.fetch ??
    (model.provider === OPENAI_COMPATIBLE_PROVIDER_ID || model.provider === "ollama"
      ? dispatcherFetch
      : globalThis.fetch);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const current = begin(true);
    try {
      const response = await baseFetch(input, init);
      const observed = observeBody(
        response,
        (payload) => {
          if (!current.transport) {
            current.transport = true;
            traceCurrent("provider.transport", { requestId, operationId: current.operationId });
          }
          const counts = piWireUsage(model.api, payload);
          if (!counts) return;
          for (const key of Object.keys(counts) as Array<keyof RawUsageCounts>) {
            if (counts[key] !== undefined && counts[key] !== null)
              current.counts[key] = counts[key];
          }
          emit(current.collector.snapshot(current.counts));
        },
        () => current.collector.limit("transport-detail-unavailable"),
      );
      // Error bodies may still supply totals; any later snapshot keeps this failed outcome.
      if (!response.ok) {
        traceCurrent("provider.finished", {
          requestId,
          operationId: current.operationId,
          outcome: "failed",
        });
        if (response.status === 429)
          traceCurrent("wait.quota", { requestId, operationId: current.operationId });
        emit(current.collector.finish("failed"));
        current.finished = true;
      }
      return observed;
    } catch (error) {
      traceCurrent("provider.finished", {
        requestId,
        operationId: current.operationId,
        outcome: options.signal?.aborted ? "cancelled" : "failed",
      });
      emit(current.collector.finish(options.signal?.aborted ? "cancelled" : "failed"));
      current.finished = true;
      throw error;
    }
  };
  void (async () => {
    try {
      if (!supported) begin(false);
      const source = start(supported ? { ...options, fetch } : options);
      for await (const event of source) {
        if (event.type === "text_delta" && event.delta && active?.http && !active.text) {
          active.text = true;
          traceCurrent("provider.text", { requestId, operationId: active.operationId });
        }
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          // Non-HTTP transports expose SDK-normalized categories, not original provider fields.
          // Pi initializes counts to zero even without usage; do not turn that into measured zero.
          if (!active) begin(false);
          if (!active!.http) {
            const positive = (value: number) => (value > 0 ? value : undefined);
            emit(
              active!.collector.snapshot({
                input: positive(
                  message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
                ),
                output: positive(message.usage.output),
                cacheRead: positive(message.usage.cacheRead),
                cacheWrite: positive(message.usage.cacheWrite),
                total: positive(message.usage.totalTokens),
              }),
            );
          }
          const outcome =
            event.type === "done"
              ? "success"
              : message.stopReason === "aborted"
                ? "cancelled"
                : "failed";
          finish(options.signal?.reason?.name === "TimeoutError" ? "timed-out" : outcome);
        }
        stream.push(event);
      }
      finish(options.signal?.aborted ? "cancelled" : "unknown");
      stream.end(await source.result());
    } catch {
      if (!active) begin(false);
      finish(options.signal?.aborted ? "cancelled" : "failed");
      const error: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: options.signal?.aborted ? "aborted" : "error",
        errorMessage: "The model stream could not complete.",
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: error.stopReason as "error" | "aborted", error });
      stream.end(error);
    }
  })();
  return stream;
}
