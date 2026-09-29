import type {
  Api,
  AssistantMessageEvent,
  Context as PiContext,
  ImageContent,
  JsonObject as PiJsonObject,
  Message as PiMessage,
  Model,
  ThinkingLevel as PiThinkingLevel,
  Tool as PiTool,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";

/**
 * Translation between Hermes's Chat Completions requests and Ardur's
 * provider-neutral model layer. The broker owns this module; nothing here
 * touches credentials, the network, or the run ledger.
 */

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

/** Pi's AssistantMessage is the full response shape; replayed turns carry identity fields. */
function replayedAssistant(
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  content: Extract<PiMessage, { role: "assistant" }>["content"],
  timestamp: number,
): PiMessage {
  return {
    role: "assistant",
    content,
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
    stopReason: "stop",
    timestamp,
  };
}

/** Chat Completions message shape as admitted by the broker's validators. */
export type AdmittedChatMessage = {
  role: string;
  content: unknown;
  name?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
  refusal?: unknown;
};

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

function textParts(content: unknown): string[] {
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (object(part)?.type === "text" ? String(part.text) : ""))
    .filter((text) => text.length > 0);
}

function imageParts(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  const images: ImageContent[] = [];
  for (const part of content) {
    const value = object(part);
    if (!value || value.type !== "image_url") continue;
    const url = object(value.image_url)?.url;
    if (typeof url !== "string") continue;
    const match = IMAGE_DATA_URL.exec(url);
    if (!match) continue;
    images.push({ type: "image", data: match[2]!, mimeType: `image/${match[1]}` });
  }
  return images;
}

const THINKING_LEVELS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Provider-layer thinking level for the pinned effort; "off" disables thinking. */
export function providerThinkingLevel(pinnedEffort: string): PiThinkingLevel | undefined {
  const level = pinnedEffort.trim().toLowerCase();
  if (!level || level === "off" || level === "none") return undefined;
  return THINKING_LEVELS.includes(level) ? (level as PiThinkingLevel) : undefined;
}

type AssistantContent = Extract<PiMessage, { role: "assistant" }>["content"];
type ToolResultContent = Extract<PiMessage, { role: "toolResult" }>["content"];

/** Broker tool catalog entries into provider-layer tools. */
export function piTools(
  tools: readonly { name: string; description?: string; parameters: JsonObject }[] | undefined,
): PiTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    // Raw JSON schema is a valid TypeBox schema via Unsafe; each provider
    // adapter serializes it back to JSON Schema on the wire.
    parameters: Type.Unsafe(tool.parameters) as unknown as PiTool["parameters"],
  }));
}

/** Find the tool name a tool_call_id refers to in the same admitted transcript. */
function toolNameForCall(
  messages: readonly AdmittedChatMessage[],
  callId: string,
): string | undefined {
  if (!callId) return undefined;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const entry = object(call);
      if (entry?.id === callId) {
        const name = object(entry.function)?.name;
        if (typeof name === "string") return name;
      }
    }
  }
  return undefined;
}

/**
 * Build the provider-layer context from an admitted Chat Completions body.
 *
 * Mapping (full table in .kimi/REPORT.md):
 * - system/developer messages join the provider-layer system prompt;
 * - user text and data-URL images become one user message;
 * - assistant text and tool_calls become one assistant message;
 * - tool messages become toolResult messages keyed by call id and name.
 */
export function piContext(body: {
  model: Pick<Model<Api>, "api" | "provider" | "id">;
  messages: readonly AdmittedChatMessage[];
  allowedTools: ReadonlyMap<string, JsonObject>;
}): PiContext {
  const system: string[] = [];
  const messages: PiMessage[] = [];
  let clock = 0;
  const timestamp = () => ++clock;
  for (const message of body.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = textParts(message.content).join("\n");
      if (text) system.push(text);
      continue;
    }
    if (message.role === "user") {
      const text = textParts(message.content).join("\n");
      const images = imageParts(message.content);
      if (!text && images.length === 0) continue;
      messages.push({
        role: "user",
        content: images.length
          ? [...(text ? [{ type: "text" as const, text }] : []), ...images]
          : text,
        timestamp: timestamp(),
      });
      continue;
    }
    if (message.role === "assistant") {
      const text = textParts(message.content).join("\n");
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const content: AssistantContent = [];
      if (text) content.push({ type: "text", text });
      for (const call of calls) {
        const entry = object(call);
        const fn = object(entry?.function);
        if (!entry || !fn) continue;
        let args: PiJsonObject = {};
        try {
          const parsed = JSON.parse(typeof fn.arguments === "string" ? fn.arguments : "{}");
          if (object(parsed)) args = parsed as PiJsonObject;
        } catch {
          // Malformed arguments cannot be replayed; a provider would reject the
          // whole request, so the call is dropped to keep the turn translatable.
        }
        content.push({
          type: "toolCall",
          id: typeof entry.id === "string" ? entry.id : `call_${timestamp()}`,
          name: String(fn.name),
          arguments: args,
        });
      }
      if (content.length)
        messages.push(replayedAssistant(body.model, content, timestamp()));
      continue;
    }
    if (message.role === "tool") {
      const text = textParts(message.content).join("\n");
      const images = imageParts(message.content);
      const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const content: ToolResultContent = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...images,
      ];
      if (!content.length) continue;
      messages.push({
        role: "toolResult",
        toolCallId: callId || `call_${timestamp()}`,
        toolName:
          (typeof message.name === "string" && message.name) ||
          toolNameForCall(body.messages, callId) ||
          "tool",
        content,
        isError: false,
        timestamp: timestamp(),
      });
    }
  }
  const tools = piTools(
    body.allowedTools.size
      ? [...body.allowedTools.entries()].map(([name, definition]) => {
          const fn = object(definition.function);
          return {
            name,
            description: typeof fn?.description === "string" ? fn.description : undefined,
            parameters: (fn?.parameters ?? { type: "object" }) as JsonObject,
          };
        })
      : undefined,
  );
  return { systemPrompt: system.join("\n\n") || undefined, messages, tools };
}

/** Map the provider layer's stop reason onto a Chat Completions finish reason. */
export function finishReason(
  reason: "stop" | "length" | "toolUse" | "deferred" | "aborted" | "error" | undefined,
): "stop" | "length" | "tool_calls" {
  if (reason === "length") return "length";
  if (reason === "toolUse") return "tool_calls";
  return "stop";
}

export type ProviderUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
};

export type ChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

/**
 * Provider usage into the Chat Completions usage block. Pi reports input
 * excluding cache for additive APIs, so prompt_tokens is the logical total.
 */
export function chatUsage(usage: ProviderUsage): ChatUsage {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: usage.totalTokens || prompt + usage.output,
  };
}

type ChatSseChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{ index: number; delta: JsonObject; finish_reason: string | null }>;
  usage?: ChatUsage;
};

/** Serialize one SSE chunk exactly the way a Chat Completions stream frames it. */
export function sseFrame(chunk: ChatSseChunk): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ["id", "object", "created", "model", "choices", "usage"] as const) {
    if (key in chunk) ordered[key] = (chunk as Record<string, unknown>)[key];
  }
  return `data: ${JSON.stringify(ordered)}\n\n`;
}

/** A provider-layer failure the broker maps onto Chat Completions error JSON. */
export class BrokerTranslationError extends Error {
  constructor(
    message: string,
    readonly aborted: boolean,
  ) {
    super(message);
    this.name = "BrokerTranslationError";
  }
}

export type ToolCallAccumulator = { id: string; name: string; arguments: string };

/**
 * Consume the provider layer's event stream and emit Chat Completions SSE
 * frames (or one JSON body when not streaming).
 *
 * Event mapping (full table in .kimi/REPORT.md):
 * - text_delta -> choices[0].delta.content
 * - thinking_delta -> choices[0].delta.reasoning_content
 * - toolcall_start -> choices[0].delta.tool_calls[i] with id and name
 * - toolcall_delta -> choices[0].delta.tool_calls[i].arguments fragment
 * - toolcall_end -> authoritative id/name/arguments for that index
 * - done -> finish_reason chunk plus usage when the provider reported it
 * - error -> BrokerTranslationError for the caller to map to HTTP JSON
 */
export async function translateStream(options: {
  stream: AsyncIterable<AssistantMessageEvent>;
  modelId: string;
  streamMode: boolean;
  onUsage: (usage: ProviderUsage) => void;
}): Promise<{
  frames: string[];
  body: JsonObject | null;
  finish: "stop" | "length" | "tool_calls";
}> {
  const { stream, modelId, streamMode } = options;
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const frames: string[] = [];
  const emit = (delta: JsonObject, finish: string | null = null) => {
    if (!streamMode) return;
    frames.push(
      sseFrame({
        id,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }),
    );
  };
  emit({ role: "assistant" });

  let text = "";
  let finish: "stop" | "length" | "tool_calls" = "stop";
  const toolCalls: ToolCallAccumulator[] = [];
  const callIndex = new Map<number, number>();
  let usage: ProviderUsage | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta": {
        text += event.delta;
        emit({ content: event.delta });
        break;
      }
      case "thinking_delta": {
        emit({ reasoning_content: event.delta });
        break;
      }
      case "toolcall_start": {
        const partial = event.partial.content[event.contentIndex];
        const slot = partial?.type === "toolCall" ? partial : undefined;
        const index = toolCalls.length;
        callIndex.set(event.contentIndex, index);
        const entry: ToolCallAccumulator = {
          id: slot?.id ?? `call_${index}`,
          name: slot?.name ?? "",
          arguments: "",
        };
        toolCalls.push(entry);
        emit({
          tool_calls: [
            {
              index,
              id: entry.id,
              type: "function",
              function: { name: entry.name, arguments: "" },
            },
          ],
        });
        break;
      }
      case "toolcall_delta": {
        const index = callIndex.get(event.contentIndex);
        if (index === undefined) break;
        toolCalls[index]!.arguments += event.delta;
        emit({
          tool_calls: [{ index, function: { arguments: event.delta } }],
        });
        break;
      }
      case "toolcall_end": {
        const index = callIndex.get(event.contentIndex);
        if (index === undefined) break;
        // The end event is authoritative: replay the complete call so a
        // provider that streamed partial JSON still round-trips exactly.
        toolCalls[index] = {
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments),
        };
        emit({
          tool_calls: [
            {
              index,
              id: event.toolCall.id,
              type: "function",
              function: {
                name: event.toolCall.name,
                arguments: toolCalls[index]!.arguments,
              },
            },
          ],
        });
        break;
      }
      case "done": {
        finish = finishReason(event.reason);
        if (event.message.usage) {
          usage = event.message.usage;
          options.onUsage(event.message.usage);
        }
        break;
      }
      case "error": {
        throw new BrokerTranslationError(
          event.error.errorMessage ?? "The model stream could not complete.",
          event.reason === "aborted",
        );
      }
      default:
        break;
    }
  }

  const usageBlock = usage ? chatUsage(usage) : undefined;
  if (streamMode) {
    emit({}, finish);
    if (usageBlock)
      frames.push(
        sseFrame({
          id,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
          usage: usageBlock,
        }),
      );
    frames.push("data: [DONE]\n\n");
  }
  const body: JsonObject = {
    id,
    object: "chat.completion",
    created,
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length
            ? {
                tool_calls: toolCalls.map((call, index) => ({
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        },
        finish_reason: finish,
      },
    ],
    ...(usageBlock ? { usage: usageBlock } : {}),
  };
  return { frames, body: streamMode ? null : body, finish };
}
