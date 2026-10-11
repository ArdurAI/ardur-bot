import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";

/** The default is always a built-in-runtime connection; native sign-ins stay with their tool. */
export function modelDefaultSelectionIssue(
  provider: string,
  modelId: string | null,
  credential: ModelCredential,
  catalog: readonly ModelCatalogEntry[],
): string | undefined {
  if (credential.provider !== provider || !credential.hasKey || credential.connectionIssue) {
    return "Connect that model first.";
  }
  if (!modelId) return "Choose a model.";
  if (provider === "ollama" || provider === "openai-compatible") {
    if (!credential.baseUrl) return "Connect that model server first.";
    return;
  }
  const entry = catalog.find(
    (entry) => entry.provider === provider && entry.id === modelId && !entry.placeholder,
  );
  if (!entry) return "Unknown model for that provider";
  if (
    (entry.auth === "oauth" && !credential.oauth) ||
    (entry.auth === "api-key" && credential.oauth)
  ) {
    return "This connection cannot serve that model.";
  }
}
