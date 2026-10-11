import type { ModelCatalogEntry, ModelCredential, RuntimeKind } from "@ardurbot/contracts";
import { hermesConnectionRefusal } from "./hermes-connections.js";
import { unavailableSubscriptionModel } from "./model-options.js";

export type ModelConnectionChoice = {
  key: string;
  entry: ModelCatalogEntry;
  credential?: ModelCredential;
  requirement: "ready" | "api-key" | "sign-in" | "local-server" | "unavailable";
};

export type CatalogModelChoice = {
  key: string;
  label: string;
  searchText: string;
  ready: boolean;
  connections: ModelConnectionChoice[];
};

/** Catalog ids, not display labels, identify models. Local tags and custom endpoints stay distinct. */
function modelKey(entry: ModelCatalogEntry): string {
  if (entry.placeholder || ["ollama", "local", "openai-compatible"].includes(entry.provider)) {
    return JSON.stringify([entry.provider, entry.id]);
  }
  return entry.catalogId ?? entry.id;
}

/** Only public connection metadata is needed; a cancelled sign-in supplies no credential. */
export function catalogModelChoices(
  catalog: readonly ModelCatalogEntry[],
  credentials: readonly ModelCredential[],
  runtime: RuntimeKind = "pi",
): CatalogModelChoice[] {
  const entries = [...catalog];
  for (const credential of credentials) {
    if (
      credential.modelId &&
      credential.provider === "openai-compatible" &&
      !entries.some(
        (entry) => entry.credentialId === credential.id && entry.id === credential.modelId,
      )
    ) {
      entries.push({
        provider: credential.provider,
        providerName: credential.label,
        id: credential.modelId,
        label: credential.modelId,
        billing: "",
        credentialId: credential.id,
      });
    }
  }
  const models = new Map<string, CatalogModelChoice>();
  for (const entry of entries) {
    const key = modelKey(entry);
    const model = models.get(key) ?? {
      key,
      label: entry.label,
      searchText: "",
      ready: false,
      connections: [],
    };
    const local = entry.provider === "ollama" || entry.provider === "local";
    const matches = credentials.filter(
      (credential) =>
        credential.provider === entry.provider &&
        (!entry.credentialId || credential.id === entry.credentialId) &&
        (entry.auth !== "oauth" || credential.oauth === true) &&
        (entry.auth !== "api-key" || !credential.oauth),
    );
    const runtimeCompatible = runtime === "pi" || runtime === "hermes";
    for (const credential of matches.length ? matches : [undefined]) {
      const incompatible =
        !runtimeCompatible ||
        (runtime === "hermes" && Boolean(hermesConnectionRefusal(entry.provider, credential)));
      const ready = Boolean(
        !incompatible &&
          credential?.hasKey &&
          !credential.connectionIssue &&
          !entry.placeholder &&
          (entry.provider !== "openai-compatible" || credential.baseUrl),
      );
      const requirement = incompatible
        ? "unavailable"
        : ready
          ? "ready"
          : local || entry.provider === "openai-compatible"
            ? "local-server"
            : credential?.connectionIssue
              ? "api-key"
              : entry.signIn
                ? "sign-in"
                : entry.auth === "oauth"
                  ? "unavailable"
                  : "api-key";
      const connectionKey = JSON.stringify([entry.provider, entry.id, credential?.id ?? null]);
      if (!model.connections.some((choice) => choice.key === connectionKey)) {
        model.connections.push({ key: connectionKey, entry, credential, requirement });
      }
      model.ready ||= ready;
    }
    model.searchText += ` ${entry.label} ${entry.id} ${entry.providerName ?? entry.provider} ${matches.map((credential) => credential.label).join(" ")}`;
    models.set(key, model);
  }
  return [...models.values()];
}

export function searchCatalogModels(models: readonly CatalogModelChoice[], query: string) {
  const words = query.trim().toLowerCase().split(/\s+/);
  return models.filter((model) =>
    words.every((word) => model.searchText.toLowerCase().includes(word)),
  );
}

/** Keep plan-limited connections behind an explicit opt-in on every surface. */
export function availableCatalogModels(
  models: readonly CatalogModelChoice[],
  showAll: boolean,
): CatalogModelChoice[] {
  if (showAll) return [...models];
  return models
    .map((model) => {
      const connections = model.connections.filter(
        (choice) =>
          !unavailableSubscriptionModel([choice.entry], choice.entry.provider, choice.entry.id),
      );
      return {
        ...model,
        connections,
        ready: connections.some((choice) => choice.requirement === "ready"),
      };
    })
    .filter((model) => model.connections.length > 0);
}
