import * as z from "zod";

export const OLLAMA_PROVIDER_ID = "ollama";
export const OLLAMA_NOT_RUNNING = "Ollama is not running. Start it and try again.";
export const OLLAMA_EMPTY = "No models installed. Pull one to start.";
export const OLLAMA_NO_IMAGES = "This model does not accept images.";

export const OllamaModelSchema = z.object({
  id: z.string(),
  parameterSize: z.string().optional(),
  acceptsImages: z.boolean(),
  reasoning: z.boolean(),
  supportsThinkingOff: z.boolean(),
  contextWindow: z.number().int().positive().optional(),
});
export type OllamaModel = z.infer<typeof OllamaModelSchema>;

export const OllamaStatusSchema = z.object({
  baseUrl: z.string(),
  credentialId: z.string().optional(),
  version: z.string().optional(),
  models: z.array(OllamaModelSchema),
  issue: z.string().optional(),
  canPull: z.boolean(),
});
export type OllamaStatus = z.infer<typeof OllamaStatusSchema>;

export const OllamaPullProgressSchema = z.object({
  status: z.string(),
  digest: z.string().optional(),
  completed: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
});
export type OllamaPullProgress = z.infer<typeof OllamaPullProgressSchema>;

/** The API chooses the default from its deployment, never the client's platform. */
export function defaultOllamaUrl(kind: "packaged" | "source"): string {
  return kind === "packaged" ? "http://host.docker.internal:11434" : "http://127.0.0.1:11434";
}

/** Native Ollama thinking is binary in this adapter. Preserve old on-level pins. */
export function ollamaThink(
  effort: string | null,
  model: Pick<OllamaModel, "reasoning" | "supportsThinkingOff">,
): boolean | undefined {
  if (!model.reasoning) {
    if (effort !== null) throw new Error("Effort is not applicable to this model.");
    return undefined;
  }
  if ((effort === "none" || effort === "off") && model.supportsThinkingOff) return false;
  if (effort === "low" || effort === "medium" || effort === "high") return true;
  throw new Error("This model does not support the pinned thinking choice.");
}

export function ollamaModelLabel(model: Pick<OllamaModel, "id" | "parameterSize">): string {
  return model.parameterSize ? `${model.id} · ${model.parameterSize}` : model.id;
}
