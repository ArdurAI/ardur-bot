import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { HermesGrantRefusalCategory } from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";
import {
  HERMES_GRANT_REFUSAL_CATEGORIES,
  HermesProviderRelayError,
  hermesProviderFailure,
} from "@ardurbot/host-runtime/runtimes/hermes-provider-failure";
import { hermesToolName } from "@ardurbot/host-runtime/runtimes/hermes-tool-names";

export { hermesToolName } from "@ardurbot/host-runtime/runtimes/hermes-tool-names";

import type { AgentUsage, UsagePurpose } from "@ardurbot/adapter-kit";
import { RequestUsageCollector } from "@ardurbot/adapter-kit";
import type { RuntimePin } from "@ardurbot/contracts";
import { RuntimeConfigOperationManifestSchema } from "@ardurbot/contracts/runtime-config";
import { canonicalRuntimeJson } from "@ardurbot/core/runtime-config";
import type {
  Api,
  AssistantMessageEvent,
  Model,
  Context as PiContext,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  type AdmittedChatMessage,
  piContext,
  providerThinkingLevel,
  translateStream,
} from "./hermes-provider-translation.js";
import { chatCompletionsUsage } from "./openai-chat-usage.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import { requestReservationTokens } from "./request-usage.js";

/**
 * Production seam to the provider layer's streamSimple. Declared here so tests
 * can stub the module boundary without importing the provider catalog.
 */
let piStreamSimpleImpl: (
  model: Model<Api>,
  context: PiContext,
  options?: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent> = () => {
  throw new Error("The provider layer bridge is not installed.");
};

/** Install the production provider-layer bridge (called by the worker's runtime registry). */
export function setHermesProviderStream(impl: typeof piStreamSimpleImpl): void {
  piStreamSimpleImpl = impl;
}

function piStreamSimple(
  model: Model<Api>,
  context: PiContext,
  options?: SimpleStreamOptions,
): AsyncIterable<AssistantMessageEvent> {
  return piStreamSimpleImpl(model, context, options);
}

const MAX_REQUEST_BYTES = 256 * 1024;
// Four raw MiB encode below the hub's six MiB provider-frame allowance.
// The remainder covers frame overhead and bounded non-provider callbacks.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_TOKEN = 2_147_483_647;

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
const keys = (value: JsonObject, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const bounded = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
const denied = (category: HermesGrantRefusalCategory = "grant"): never => {
  throw new HermesProviderRelayError({ kind: "grant-refused", category });
};

export type BrokerScope = {
  runId: string;
  botId: string;
  userId: string;
  spaceId: string;
  operationId: string;
  leaseOwner: string;
  leaseFence: number;
  hostGeneration: number;
  configurationHash: string;
  briefAttemptedAt?: string;
  pin: { credentialId: string; provider: string; modelId: string; effort: string };
};

/** A maintenance operation keeps the source pin but has its own bounded admission identity. */
export function summaryOperationManifest(pin: RuntimePin, maxOutputTokens: number) {
  const hash = pin.effectiveRuntimeConfigHash ?? pin.runtimeConfigHash;
  if (
    pin.runtimeKind !== "hermes" ||
    !hash ||
    (pin.runtimeConfig?.version === 2 && !pin.effectiveRuntimeConfigHash) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 65_536
  )
    throw new Error("The summary configuration is incomplete.");
  return RuntimeConfigOperationManifestSchema.parse({
    format: 1 as const,
    purpose: "summary" as const,
    sourceEffectiveRuntimeConfigHash: hash,
    maxOutputTokens,
    tools: "none" as const,
    modelId: pin.modelId,
    effort: pin.effort,
  });
}

export function summaryOperationHash(
  manifest: ReturnType<typeof summaryOperationManifest>,
): string {
  return createHash("sha256")
    .update("ardur:runtime-operation:v1\n", "utf8")
    .update(canonicalRuntimeJson(manifest), "utf8")
    .digest("hex");
}

/** How the broker satisfies a request for one pinned connection. */
export type BrokerRoute =
  /** Hermes speaks Chat Completions and the provider speaks it natively; bytes pass through unchanged. */
  | "openai-completions"
  /** The provider speaks another protocol; the broker translates through Ardur's provider layer. */
  | "provider-translated";

/** A model entry from Ardur's provider catalog for the translated route. */
export type BrokerCatalogModel = {
  model: Model<Api>;
  /** Owner-resolved API key from the same credential resolution the bot's own runs use. */
  apiKey?: string;
};

export type BrokerConnection = {
  credentialId: string;
  provider: string;
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  route: BrokerRoute;
  contextWindow: number;
  maxOutputTokens: number;
  acceptsImages: boolean;
  supportsDeveloperRole: boolean;
  effort: {
    field: "reasoning_effort" | "none";
    supported: readonly string[];
  };
  reportedModel: "required" | "if-present";
};

export type BrokerTool = {
  name: string;
  description?: string;
  parameters: JsonObject;
};

export type BrokerGrant = {
  id: string;
  token: string;
  expiresAt: number;
};

export type BrokerRequest = {
  grant: BrokerGrant;
  scope: BrokerScope;
  path: string;
  body: unknown;
  signal?: AbortSignal;
};

export type BrokerOptions = {
  scope: BrokerScope;
  connection: BrokerConnection;
  credentialId: string;
  pinnedEffort: string;
  tools: readonly BrokerTool[];
  purpose?: UsagePurpose;
  maxRequests: number;
  maxReservedTokens: number;
  expiresAt: number;
  /** Rechecks cancellation, lease and connection revocation before each invocation. */
  active: () => Promise<boolean>;
  /** A started observation must commit before the provider transport is called. */
  record: (usage: AgentUsage) => Promise<void>;
  observed?: (model: string | undefined, effort: string | undefined) => Promise<void>;
  requiredContext?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Catalog model for the translated route. The broker never accepts a key or
   * model from the request; this is the owner's connection resolution, exactly
   * the way the worker resolves the bot's own model. Pass a `streamSimple`
   * implementation for tests; production resolves it from the catalog model.
   */
  catalog?: BrokerCatalogModel;
  /** Test seam over the provider layer's streamSimple. Production builds it from `catalog`. */
  streamSimple?: (
    model: Model<Api> | undefined,
    context: PiContext,
    options?: SimpleStreamOptions,
  ) => AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>;
};

function catalog(tools: readonly BrokerTool[]): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const tool of tools) {
    if (!tool.name || tool.name === "run_subagent") denied();
    const name = hermesToolName(tool.name);
    if (result.has(name) || !object(tool.parameters)) denied();
    result.set(name, {
      type: "function",
      function: {
        name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
      },
    });
  }
  return result;
}

function validContent(content: unknown, images: boolean): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content) || content.length > 64) return false;
  return content.every((part) => {
    const value = object(part);
    if (!value) return false;
    if (value.type === "text")
      return keys(value, ["type", "text"]) && typeof value.text === "string";
    if (value.type !== "image_url" || !images || !keys(value, ["type", "image_url"])) return false;
    const image = object(value.image_url);
    return Boolean(
      image &&
        keys(image, ["url", "detail"]) &&
        typeof image.url === "string" &&
        image.url.trim().length > 0 &&
        (image.detail === undefined || ["auto", "low", "high"].includes(String(image.detail))),
    );
  });
}

function validMessage(
  value: unknown,
  images: boolean,
  developer: boolean,
  allowed: ReadonlyMap<string, JsonObject>,
): boolean {
  const message = object(value);
  if (
    !message ||
    !["system", "developer", "user", "assistant", "tool"].includes(String(message.role))
  )
    return false;
  if (message.role === "developer" && !developer) return false;
  if (!keys(message, ["role", "content", "name", "tool_call_id", "tool_calls", "refusal"]))
    return false;
  if (
    !validContent(message.content, images) &&
    !(
      message.role === "assistant" &&
      message.content === null &&
      Array.isArray(message.tool_calls)
    ) &&
    !(message.role === "tool" && (message.content === null || message.content === undefined))
  )
    return false;
  if (message.name !== undefined && typeof message.name !== "string") return false;
  if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") return false;
  if (message.refusal !== undefined && typeof message.refusal !== "string") return false;
  if (message.tool_calls !== undefined) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return false;
    for (const call of message.tool_calls) {
      const entry = object(call);
      const fn = object(entry?.function);
      if (
        !entry ||
        !fn ||
        !keys(entry, ["id", "type", "function"]) ||
        entry.type !== "function" ||
        typeof entry.id !== "string" ||
        !keys(fn, ["name", "arguments"]) ||
        typeof fn.name !== "string" ||
        !allowed.has(fn.name) ||
        typeof fn.arguments !== "string"
      )
        return false;
    }
  }
  return true;
}

function admittedBody(
  input: unknown,
  connection: BrokerConnection,
  pinnedEffort: string,
  allowed: ReadonlyMap<string, JsonObject>,
): JsonObject {
  const body = object(input);
  if (!body) return denied("messages");
  const admittedFields = [
    "model",
    "messages",
    "tools",
    "tool_choice",
    "stream",
    "stream_options",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
    "temperature",
    "top_p",
    "stop",
    "parallel_tool_calls",
  ];
  const unknownField = Object.keys(body).find((field) => !admittedFields.includes(field));
  if (unknownField !== undefined) {
    const category = HERMES_GRANT_REFUSAL_CATEGORIES.find(
      (value) => value === `unknown-field:${unknownField}`,
    );
    denied(category ?? "unknown-field");
  }
  if (body.model !== connection.modelId) denied("model");
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > 256 ||
    !body.messages.every((message) =>
      validMessage(message, connection.acceptsImages, connection.supportsDeveloperRole, allowed),
    )
  )
    denied("messages");
  if (body.stream !== undefined && typeof body.stream !== "boolean") denied("stream-options");
  if (body.stream_options !== undefined) {
    const options = object(body.stream_options);
    if (
      !body.stream ||
      !options ||
      !keys(options, ["include_usage"]) ||
      options.include_usage !== true
    )
      denied("stream-options");
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false) denied("tools");
  if (
    body.temperature !== undefined &&
    (typeof body.temperature !== "number" ||
      !Number.isFinite(body.temperature) ||
      body.temperature < 0 ||
      body.temperature > 2)
  )
    denied("sampling");
  if (
    body.top_p !== undefined &&
    (typeof body.top_p !== "number" ||
      !Number.isFinite(body.top_p) ||
      body.top_p < 0 ||
      body.top_p > 1)
  )
    denied("sampling");
  if (
    body.stop !== undefined &&
    !(
      typeof body.stop === "string" ||
      (Array.isArray(body.stop) &&
        body.stop.length <= 4 &&
        body.stop.every((item) => typeof item === "string"))
    )
  )
    denied("sampling");
  const hasMaxTokens = Object.hasOwn(body, "max_tokens");
  const hasMaxCompletionTokens = Object.hasOwn(body, "max_completion_tokens");
  if (
    (hasMaxTokens && hasMaxCompletionTokens) ||
    (hasMaxTokens && !bounded(body.max_tokens, connection.maxOutputTokens)) ||
    (hasMaxCompletionTokens && !bounded(body.max_completion_tokens, connection.maxOutputTokens))
  )
    denied("output-tokens");
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > allowed.size) return denied("tools");
    const seen = new Set<string>();
    for (const item of body.tools) {
      const tool = object(item);
      const fn = object(tool?.function);
      if (
        !tool ||
        !fn ||
        !keys(tool, ["type", "function"]) ||
        tool.type !== "function" ||
        !keys(fn, ["name", "description", "parameters", "strict"]) ||
        typeof fn.name !== "string" ||
        !allowed.has(fn.name) ||
        seen.has(fn.name)
      )
        denied("tools");
      seen.add(String(fn?.name));
    }
  }
  const choice = body.tool_choice;
  if (choice !== undefined && !["auto", "none", "required"].includes(String(choice))) {
    const value = object(choice);
    const fn = object(value?.function);
    if (
      !value ||
      !fn ||
      !keys(value, ["type", "function"]) ||
      value.type !== "function" ||
      !keys(fn, ["name"]) ||
      typeof fn.name !== "string" ||
      !allowed.has(fn.name)
    )
      denied("tool-choice");
  }
  if (choice === "required" && (!Array.isArray(body.tools) || body.tools.length === 0))
    denied("tool-choice");
  if (!connection.effort.supported.includes(pinnedEffort)) return denied("effort");
  const wireEffort = pinnedEffort === "off" ? "none" : pinnedEffort;
  if (connection.effort.field === "none") {
    if (pinnedEffort !== "off" || body.reasoning_effort !== undefined) denied("effort");
  } else if (body.reasoning_effort !== undefined && body.reasoning_effort !== wireEffort)
    denied("effort");
  const selected = Array.isArray(body.tools)
    ? body.tools.map((item) => allowed.get(String(object(object(item)?.function)?.name)))
    : undefined;
  if (object(choice)?.function) {
    const selectedName = object(object(choice)?.function)?.name;
    if (
      !Array.isArray(body.tools) ||
      !body.tools.some((item) => object(object(item)?.function)?.name === selectedName)
    )
      denied("tool-choice");
  }
  return {
    ...body,
    tools: selected,
    ...(!hasMaxTokens && !hasMaxCompletionTokens ? { max_tokens: connection.maxOutputTokens } : {}),
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    ...(connection.effort.field === "reasoning_effort" ? { reasoning_effort: wireEffort } : {}),
  };
}

/**
 * The admitted Chat Completions body for the translated route. Same admission
 * rules as the pass-through path, minus the wire-only rewrites (max_tokens
 * default, stream_options, reasoning_effort) the provider layer generates
 * itself from the model entry and the pinned effort.
 */
function admittedTranslatedBody(
  input: unknown,
  connection: BrokerConnection,
  pinnedEffort: string,
  allowed: ReadonlyMap<string, JsonObject>,
): JsonObject {
  const body = object(input);
  if (!body) return denied();

  const admitted = admittedBody(
    {
      ...body,
      // The provider layer owns these wire fields on the translated route.
      stream_options: body.stream_options,
      max_tokens: Object.hasOwn(body, "max_tokens")
        ? body.max_tokens
        : Object.hasOwn(body, "max_completion_tokens")
          ? undefined
          : connection.maxOutputTokens,
      reasoning_effort: undefined,
    },
    connection,
    pinnedEffort,
    allowed,
  );
  return {
    ...admitted,
    ...(body.reasoning_effort !== undefined ? { reasoning_effort: body.reasoning_effort } : {}),
  };
}

/** Dormant worker-only broker. The host relay is composed in a later stream. */
export class HermesProviderBroker {
  private deliveredBytes = 0;
  readonly grant: BrokerGrant;
  private readonly options: BrokerOptions;
  private readonly allowed: Map<string, JsonObject>;
  private readonly transport: typeof globalThis.fetch;
  private readonly translated: boolean;
  private revoked = false;
  private busy = false;
  private controller: AbortController | null = null;

  constructor(options: BrokerOptions) {
    this.options = {
      ...options,
      scope: structuredClone(options.scope),
      connection: {
        ...options.connection,
        effort: {
          ...options.connection.effort,
          supported: [...options.connection.effort.supported],
        },
      },
      tools: options.tools.map((tool) => ({
        ...tool,
        parameters: structuredClone(tool.parameters),
      })),
    };
    const { connection } = this.options;
    this.translated = connection.route === "provider-translated";
    if (
      !["openai-completions", "provider-translated"].includes(connection.route) ||
      connection.credentialId !== options.credentialId ||
      options.scope.pin.credentialId !== connection.credentialId ||
      options.scope.pin.provider !== connection.provider ||
      options.scope.pin.modelId !== connection.modelId ||
      options.scope.pin.effort !== options.pinnedEffort ||
      !bounded(connection.contextWindow, MAX_TOKEN) ||
      !bounded(connection.maxOutputTokens, MAX_TOKEN) ||
      !bounded(options.maxRequests, 64) ||
      !bounded(options.maxReservedTokens, MAX_TOKEN) ||
      !Number.isSafeInteger(options.scope.leaseFence) ||
      !Number.isSafeInteger(options.scope.hostGeneration) ||
      !Number.isFinite(options.expiresAt) ||
      options.expiresAt <= Date.now() ||
      options.expiresAt > Date.now() + 600_000
    )
      denied();
    if (this.translated) {
      // The translated route never speaks HTTP to the connection URL from the
      // request; the provider layer owns the real endpoint and credentials.
      // A catalog model or an explicit stream seam must exist, and the model
      // must describe the pinned connection exactly.
      if (!this.options.catalog && !this.options.streamSimple) denied();
      const model = this.options.catalog?.model;
      if (model) {
        if (
          model.provider !== connection.provider ||
          model.id !== connection.modelId ||
          !model.input.includes("text")
        )
          denied();
        if (connection.acceptsImages && !model.input.includes("image")) denied();
      }
    } else {
      const url = assertAllowedOpenAiCompatibleUrl(connection.baseUrl);
      assertHttpsForKeyedOpenAiCompatibleUrl(url, connection.apiKey);
    }
    this.allowed = catalog(this.options.tools);
    this.transport = createOpenAiCompatibleFetch(options.fetch);
    this.grant = Object.freeze({
      id: randomUUID(),
      token: randomBytes(32).toString("base64url"),
      expiresAt: options.expiresAt,
    });
  }

  revoke() {
    this.revoked = true;
    this.controller?.abort();
  }

  private checkGrant(request: BrokerRequest) {
    const actual = Buffer.from(request.grant.token);
    const expected = Buffer.from(this.grant.token);
    if (
      this.revoked ||
      Date.now() >= this.grant.expiresAt ||
      this.busy ||
      request.grant.id !== this.grant.id ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected) ||
      !isDeepStrictEqual(request.scope, this.options.scope) ||
      request.path !== "/v1/chat/completions"
    )
      denied();
  }

  async open(request: BrokerRequest): Promise<Response> {
    this.checkGrant(request);
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const expiry = setTimeout(abort, Math.max(0, this.grant.expiresAt - Date.now()));
    const live = () => {
      if (this.revoked || controller.signal.aborted || Date.now() >= this.grant.expiresAt) denied();
    };
    const active = async () => {
      live();
      if (!(await this.options.active())) {
        controller.abort();
        denied();
      }
      live();
    };
    try {
      const { connection } = this.options;
      const body = this.translated
        ? admittedTranslatedBody(request.body, connection, this.options.pinnedEffort, this.allowed)
        : admittedBody(request.body, connection, this.options.pinnedEffort, this.allowed);
      if (this.options.requiredContext) {
        const text = (body.messages as Array<{ content?: unknown }>)
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : Array.isArray(message.content)
                ? message.content
                    .map((part: { text?: unknown }) =>
                      typeof part.text === "string" ? part.text : "",
                    )
                    .join("\n")
                : "",
          )
          .join("\n");
        if (!text.includes(this.options.requiredContext)) denied("context");
      }
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) denied("request-bytes");
      await active();
      const outputCap = Number(body.max_tokens ?? body.max_completion_tokens);
      const reservedTokens = requestReservationTokens(encoded, connection.contextWindow, outputCap);
      if (!bounded(reservedTokens, MAX_TOKEN)) denied("run-budget");
      const collector = new RequestUsageCollector({
        provider: connection.provider,
        model: connection.modelId,
        requestId: randomUUID(),
        attemptId: "0",
        purpose: this.options.purpose ?? "unknown",
        mappingVersion: "broker-chat-completions-v1",
        inputSemantics: "total-with-cache-subsets",
        admission: {
          kind: "worker-provider-broker",
          reservedTokens,
          maxRequests: this.options.maxRequests,
          maxReservedTokens: this.options.maxReservedTokens,
        },
      });
      let finished = false;
      const finish = async (
        outcome: "success" | "failed" | "cancelled" | "timed-out" | "unknown",
      ) => {
        if (finished) return;
        finished = true;
        await this.options.record(collector.finish(outcome));
      };
      try {
        await this.options.record(collector.start());
      } catch {
        denied("run-budget");
      }
      if (this.translated)
        return await this.openTranslated(body, controller, collector, finish, live, active);
      let responseBody: ReadableStream<Uint8Array> | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        await active();
        const url = `${assertAllowedOpenAiCompatibleUrl(connection.baseUrl).toString().replace(/\/$/, "")}/chat/completions`;
        live();
        const response = await this.transport(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}),
          },
          body: encoded,
          signal: controller.signal,
        });
        responseBody = response.body;
        await active();
        const mime = response.headers.get("content-type") ?? "";
        if (!mime.includes("application/json") && !mime.includes("text/event-stream")) {
          controller.abort();
          void response.body?.cancel().catch(() => undefined);
          await finish("failed");
          throw new Error("Provider response format is unsupported.");
        }
        if (response.ok && Boolean(body.stream) !== mime.includes("text/event-stream")) {
          controller.abort();
          void response.body?.cancel().catch(() => undefined);
          await finish("failed");
          throw new Error("Provider stream format did not match the request.");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        let observedModel = false;
        const capture = async (payload: unknown) => {
          const value = object(payload);
          if (!value) return;
          const counts = chatCompletionsUsage(payload);
          if (counts) await this.options.record(collector.snapshot(counts));
          await active();
          if (object(value.error)) throw new Error("Provider reported an error.");
          if (value.model !== undefined && value.model !== connection.modelId) {
            await finish("failed");
            throw new Error("Provider reported a different model.");
          }
          if (value.model === connection.modelId) observedModel = true;
        };
        const sse = mime.includes("text/event-stream");
        const decoder = new TextDecoder();
        let pendingLine = "";
        const parseLines = async (text: string, flush = false) => {
          pendingLine += text;
          let index = pendingLine.indexOf("\n");
          while (index >= 0) {
            const line = pendingLine.slice(0, index).replace(/\r$/, "");
            pendingLine = pendingLine.slice(index + 1);
            index = pendingLine.indexOf("\n");
            if (Buffer.byteLength(line) > MAX_EVENT_BYTES)
              throw new Error("Provider event exceeded the broker limit.");
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              await capture(JSON.parse(data));
            } catch (error) {
              if (!(error instanceof SyntaxError)) throw error;
            }
          }
          if (Buffer.byteLength(pendingLine) > MAX_EVENT_BYTES)
            throw new Error("Provider event exceeded the broker limit.");
          if (flush && pendingLine) await parseLines("\n");
        };
        reader = responseBody?.getReader();
        if (reader) {
          while (true) {
            const next = await reader.read();
            await active();
            if (next.done) break;
            size += next.value.byteLength;
            if (sse) {
              const available = Math.max(0, MAX_RESPONSE_BYTES - (size - next.value.byteLength));
              await parseLines(decoder.decode(next.value.subarray(0, available), { stream: true }));
              await active();
            }
            if (size > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new Error("Provider response exceeded the broker limit.");
            }
            chunks.push(next.value);
          }
        }
        if (sse) await parseLines(decoder.decode(), true);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (!sse) {
          try {
            await capture(JSON.parse(new TextDecoder().decode(bytes)));
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            await finish("failed");
            throw new Error("Provider returned invalid JSON.");
          }
        }
        if (connection.reportedModel === "required" && !observedModel) {
          await finish("failed");
          throw new Error("Provider model identity is unavailable.");
        }
        if (this.deliveredBytes + size > MAX_RESPONSE_BYTES) {
          await finish("failed");
          throw new Error("Provider response exceeded the turn limit.");
        }
        if (controller.signal.aborted || this.revoked || Date.now() >= this.grant.expiresAt) {
          await finish(Date.now() >= this.grant.expiresAt ? "timed-out" : "cancelled");
          throw new Error("Provider request was cancelled.");
        }
        if (response.ok)
          await this.options.observed?.(
            observedModel ? connection.modelId : undefined,
            typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
          );
        await finish(response.ok ? "success" : "failed");
        if (response.ok) this.deliveredBytes += size;
        return new Response(response.ok ? bytes : "Provider request failed.", {
          status: response.status,
          headers: { "content-type": response.ok ? mime : "text/plain" },
        });
      } catch (error) {
        const outcome = controller.signal.aborted
          ? Date.now() >= this.grant.expiresAt
            ? "timed-out"
            : "cancelled"
          : "failed";
        controller.abort();
        if (reader) void reader.cancel().catch(() => undefined);
        else void responseBody?.cancel().catch(() => undefined);
        try {
          await finish(outcome);
        } catch {
          // The started reservation remains durable when a terminal write fails.
        }
        throw new HermesProviderRelayError(hermesProviderFailure(error));
      }
    } finally {
      clearTimeout(expiry);
      request.signal?.removeEventListener("abort", abort);
      this.controller = null;
      this.busy = false;
    }
  }

  /**
   * The translated route: build a provider-layer context from the admitted
   * Chat Completions body and serialize the provider layer's events back to
   * Chat Completions. Grants, caps and accounting were admitted by open()
   * before this runs, exactly as for pass-through calls.
   */
  private async openTranslated(
    body: JsonObject,
    controller: AbortController,
    collector: RequestUsageCollector,
    finish: (
      outcome: "success" | "failed" | "cancelled" | "timed-out" | "unknown",
    ) => Promise<void>,
    live: () => void,
    active: () => Promise<void>,
  ): Promise<Response> {
    const { connection } = this.options;
    const catalog = this.options.catalog;
    const model = catalog?.model;
    try {
      live();
      await active();
      const context = piContext({
        model: model ?? {
          api: "openai-completions",
          provider: connection.provider,
          id: connection.modelId,
        },
        messages: body.messages as AdmittedChatMessage[],
        allowedTools: this.allowed,
      });
      const options: SimpleStreamOptions = {
        signal: controller.signal,
        apiKey: catalog?.apiKey,
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(body.max_tokens !== undefined || body.max_completion_tokens !== undefined
          ? { maxTokens: Number(body.max_tokens ?? body.max_completion_tokens) }
          : {}),
        ...(providerThinkingLevel(this.options.pinnedEffort)
          ? { reasoning: providerThinkingLevel(this.options.pinnedEffort) }
          : {}),
        ...(Array.isArray(body.stop)
          ? { samplingParams: { stop: body.stop } }
          : typeof body.stop === "string"
            ? { samplingParams: { stop: [body.stop] } }
            : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      };
      const invoked = this.options.streamSimple
        ? this.options.streamSimple(model, context, options)
        : piStreamSimple(model!, context, options);
      // Provider seams may return the stream or a promise of it; both iterate.
      const stream = (await invoked) as AsyncIterable<AssistantMessageEvent>;
      const result = await translateStream({
        stream,
        modelId: connection.modelId,
        streamMode: body.stream === true,
        onUsage: (usage) => {
          // Feed the broker accounting with the provider layer's counts so run
          // caps and honest usage match the pass-through path.
          void this.options.record(collector.snapshot(usage));
        },
      });
      await active();
      live();
      const payload = result.frames.join("") || JSON.stringify(result.body);
      const bytes = Buffer.from(payload, "utf8");
      const size = bytes.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await finish("failed");
        throw new Error("Provider response exceeded the broker limit.");
      }
      if (this.deliveredBytes + size > MAX_RESPONSE_BYTES) {
        await finish("failed");
        throw new Error("Provider response exceeded the turn limit.");
      }
      if (controller.signal.aborted || this.revoked || Date.now() >= this.grant.expiresAt) {
        await finish(Date.now() >= this.grant.expiresAt ? "timed-out" : "cancelled");
        throw new Error("Provider request was cancelled.");
      }
      await this.options.observed?.(connection.modelId, this.options.pinnedEffort);
      await finish("success");
      this.deliveredBytes += size;
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": body.stream === true ? "text/event-stream" : "application/json",
        },
      });
    } catch (error) {
      // Compute the outcome before aborting, exactly like the pass-through path.
      const outcome = controller.signal.aborted
        ? Date.now() >= this.grant.expiresAt
          ? "timed-out"
          : "cancelled"
        : "failed";
      controller.abort();
      try {
        await finish(outcome);
      } catch {
        // The started reservation remains durable when a terminal write fails.
      }
      if (outcome === "cancelled" || outcome === "timed-out")
        throw new Error("Provider request was cancelled.");
      const isInlineImageError =
        error instanceof Error && error.message === "Only inline images are supported.";
      const status = isInlineImageError
        ? 400
        : error instanceof Error
          ? providerErrorStatus(error)
          : 500;
      return new Response(
        JSON.stringify({
          error: {
            message: isInlineImageError ? error.message : "Provider request failed.",
            type: status === 400 ? "invalid_request_error" : "api_error",
            code: status,
          },
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    }
  }
}

/** Same status classes the pass-through path surfaces from provider HTTP codes. */
function providerErrorStatus(error: Error): 400 | 401 | 429 | 500 {
  const text = error.message.toLowerCase();
  if (/unauthorized|invalid[ _-]api[ _-]key|authentication|token expired|api[ _-]key/.test(text))
    return 401;
  if (/rate limit|too many requests|quota/.test(text)) return 429;
  if (/not found|unknown model|unsupported|invalid|malformed|must /.test(text)) return 400;
  return 500;
}

export class HermesRelayDispatcher {
  private opening = false;
  private response: Buffer | undefined;
  private responseStatus = 200;
  private responseType: "application/json" | "text/event-stream" = "application/json";
  private readSequence = 0;

  constructor(
    private readonly brokerSession: { broker: HermesProviderBroker; scope: BrokerScope },
    private readonly abortSignal: AbortSignal,
  ) {}

  async dispatch(method: string, args: unknown[]) {
    if (method === "provider.cancel") {
      if (this.opening) this.brokerSession.broker.revoke();
      this.response = undefined;
      return;
    }
    if (method === "provider.open") {
      if (this.opening || this.response) throw new Error("Provider request is already active.");
      this.opening = true;
      try {
        const opened = await this.brokerSession.broker.open({
          grant: this.brokerSession.broker.grant,
          scope: this.brokerSession.scope,
          path: "/v1/chat/completions",
          body: args[0],
          signal: this.abortSignal,
        });
        if (!opened.ok)
          throw new HermesProviderRelayError({ kind: "provider-http", status: opened.status });
        this.responseStatus = opened.status;
        this.responseType = opened.headers.get("content-type")?.includes("text/event-stream")
          ? "text/event-stream"
          : "application/json";
        this.response = Buffer.from(await opened.arrayBuffer());
        this.readSequence = 0;
        return { status: this.responseStatus, contentType: this.responseType };
      } finally {
        this.opening = false;
      }
    }
    if (!this.response || args[0] !== this.readSequence)
      throw new Error("Provider response sequence changed.");
    const chunk = this.response.subarray(
      this.readSequence * 24 * 1024,
      (this.readSequence + 1) * 24 * 1024,
    );
    const done = (this.readSequence + 1) * 24 * 1024 >= this.response.length;
    const seq = this.readSequence++;
    if (done) this.response = undefined;
    return { seq, chunk: chunk.toString("base64"), done };
  }
}
