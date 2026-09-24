import type { ModelCatalogEntry, OllamaModel, OllamaPullProgress } from "@ardurbot/contracts";
import {
  OLLAMA_NOT_RUNNING,
  OllamaPullProgressSchema,
  ollamaModelLabel,
} from "@ardurbot/contracts";
import * as z from "zod";
import { assertAllowedOpenAiCompatibleRequestUrl } from "./openai-compatible-url.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

const modelName = z.string().trim().min(1).max(256);
const tagsSchema = z.object({
  models: z
    .array(
      z.object({
        name: modelName,
        details: z.object({ parameter_size: z.string().max(80).optional() }).optional(),
      }),
    )
    .max(500),
});
const showSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  model_info: z.record(z.string(), z.unknown()).optional(),
  thinking: z.object({ values: z.array(z.union([z.boolean(), z.string()])) }).optional(),
});
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export function ollamaErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return "Ollama returned invalid model information. Try again.";
  if (error instanceof Error && error.name === "TimeoutError")
    return "Ollama took too long. Try again.";
  return error instanceof Error ? error.message : "Could not check Ollama. Try again.";
}

export function normalizeOllamaUrl(raw: string): string {
  const url = assertAllowedOpenAiCompatibleRequestUrl(raw.trim());
  if (url.search || url.hash)
    throw new Error("Use the Ollama server URL without a query or fragment.");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

function connectionError(error: unknown): Error {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  if (
    code === "ECONNREFUSED" ||
    (error instanceof Error && "code" in error && error.code === "ECONNREFUSED")
  )
    return new Error(OLLAMA_NOT_RUNNING);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return error;
  return new Error("Could not reach Ollama. Check the server URL and try again.");
}

async function request(
  baseUrl: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const safeFetch = createOpenAiCompatibleFetch(fetchImpl);
  let response: Response;
  try {
    response = await safeFetch(`${normalizeOllamaUrl(baseUrl)}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw connectionError(error);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 404
        ? "This Ollama model is not installed. Change pin."
        : "Ollama could not complete the request. Try again.",
    );
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Ollama returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_JSON_BYTES) throw new Error("Ollama returned too much model information.");
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function budget(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function listOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
) {
  return tagsSchema.parse(
    await readJson(await request(baseUrl, "tags", undefined, budget(signal), fetchImpl)),
  ).models;
}

export async function showOllamaModel(
  baseUrl: string,
  id: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<OllamaModel> {
  const show = showSchema.parse(
    await readJson(
      await request(baseUrl, "show", { model: modelName.parse(id) }, budget(signal), fetchImpl),
    ),
  );
  const contexts = Object.entries(show.model_info ?? {})
    .filter(
      ([key, value]) =>
        key.endsWith(".context_length") &&
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0,
    )
    .map(([, value]) => value as number);
  const architecture = show.model_info?.["general.architecture"];
  const familyContext =
    typeof architecture === "string"
      ? show.model_info?.[`${architecture}.context_length`]
      : undefined;
  const contextWindow =
    typeof familyContext === "number" && Number.isSafeInteger(familyContext) && familyContext > 0
      ? familyContext
      : contexts.length === 1
        ? contexts[0]
        : undefined;
  return {
    id,
    acceptsImages: show.capabilities?.includes("vision") ?? false,
    reasoning: show.capabilities?.includes("thinking") ?? false,
    supportsThinkingOff: show.thinking ? show.thinking.values.includes(false) : true,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

export async function discoverOllama(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
) {
  const deadline = budget(signal);
  const [tags, version] = await Promise.all([
    listOllamaModels(baseUrl, deadline, fetchImpl),
    request(baseUrl, "version", undefined, deadline, fetchImpl)
      .then(readJson)
      .then((body) => z.object({ version: z.string().max(128) }).parse(body).version),
  ]);
  const models: OllamaModel[] = [];
  // Bound requests even on servers with many installed models.
  for (let i = 0; i < tags.length; i += 4) {
    models.push(
      ...(await Promise.all(
        tags.slice(i, i + 4).map(async (tag) => ({
          ...(await showOllamaModel(baseUrl, tag.name, deadline, fetchImpl)),
          parameterSize: tag.details?.parameter_size,
        })),
      )),
    );
  }
  return { version, models };
}

export const ollamaCatalogPlaceholder: ModelCatalogEntry = {
  provider: "ollama",
  providerName: "Ollama",
  id: "",
  label: "Ollama",
  billing: "",
  placeholder: true,
};

export function ollamaCatalog(models: OllamaModel[], credentialId: string): ModelCatalogEntry[] {
  return models.map((model) => ({
    provider: "ollama",
    providerName: "Ollama",
    id: model.id,
    label: ollamaModelLabel(model),
    billing: "",
    credentialId,
    reasoning: model.reasoning,
    acceptsImages: model.acceptsImages,
    contextWindow: model.contextWindow,
    parameterSize: model.parameterSize,
    thinkingLevels: model.reasoning
      ? model.supportsThinkingOff
        ? ["off", "low", "medium", "high"]
        : ["low", "medium", "high"]
      : [],
  }));
}

/** Ollama API: Pull a Model. NDJSON may split at any UTF-8 or line boundary. */
export async function* pullOllamaModel(
  baseUrl: string,
  model: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): AsyncGenerator<OllamaPullProgress> {
  const response = await request(
    baseUrl,
    "pull",
    { model: modelName.parse(model), stream: true },
    signal,
    fetchImpl,
  );
  if (!response.body) throw new Error("Ollama returned no pull progress.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let succeeded = false;
  const parse = (line: string) => {
    const raw: unknown = JSON.parse(line);
    if (raw && typeof raw === "object" && "error" in raw)
      throw new Error("Ollama could not pull this model. Check its name and try again.");
    const progress = OllamaPullProgressSchema.parse(raw);
    succeeded = progress.status === "success";
    return progress;
  };
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 64 * 1024) throw new Error("Ollama returned too much pull progress.");
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield parse(line);
        newline = pending.indexOf("\n");
      }
      if (done) break;
    }
    if (pending.trim()) yield parse(pending);
    if (!succeeded) throw new Error("The model pull stopped before it finished. Try again.");
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
