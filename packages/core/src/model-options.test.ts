import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  availableProviderModels,
  connectedModelOptions,
  unavailableSubscriptionModel,
} from "./model-options.js";

function entry(
  partial: Pick<ModelCatalogEntry, "provider" | "id"> & Partial<ModelCatalogEntry>,
): ModelCatalogEntry {
  return {
    label: partial.id,
    billing: "usage",
    ...partial,
  };
}

function credential(
  partial: Pick<ModelCredential, "id" | "provider" | "label"> & Partial<ModelCredential>,
): ModelCredential {
  return {
    hasKey: true,
    isDefault: false,
    ...partial,
  };
}

describe("model-options", () => {
  it("hides a subscription model the account cannot use, and shows it when every model is requested", () => {
    const catalog = [
      entry({
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        auth: "oauth",
        billing: "subscription",
      }),
      entry({
        provider: "openai-codex",
        id: "gpt-6-astra",
        auth: "oauth",
        billing: "subscription",
      }),
      entry({ provider: "openai", id: "gpt-5.3-codex-spark", auth: "api-key" }),
    ];

    expect(
      availableProviderModels(catalog, "openai-codex", false).map((model) => model.id),
    ).toEqual(["gpt-6-astra"]);
    expect(availableProviderModels(catalog, "openai-codex", true).map((model) => model.id)).toEqual(
      ["gpt-5.3-codex-spark", "gpt-6-astra"],
    );
    expect(availableProviderModels(catalog, "openai", false).map((model) => model.id)).toEqual([
      "gpt-5.3-codex-spark",
    ]);
  });

  it("marks only an oauth subscription model unavailable", () => {
    const catalog = [
      entry({
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        auth: "oauth",
        billing: "subscription",
      }),
      entry({
        provider: "openai-codex",
        id: "gpt-6-astra",
        auth: "oauth",
        billing: "subscription",
      }),
    ];
    expect(unavailableSubscriptionModel(catalog, "openai-codex", "gpt-5.3-codex-spark")).toBe(true);
    expect(unavailableSubscriptionModel(catalog, "openai-codex", "gpt-6-astra")).toBe(false);
    expect(unavailableSubscriptionModel(catalog, "openai", "gpt-5.3-codex-spark")).toBe(false);
  });

  it("lists hosted connections before local ones and drops the unavailable subscription model", () => {
    const catalog = [
      entry({ provider: "openai", id: "hosted", label: "Hosted", auth: "api-key" }),
      entry({ provider: "ollama", id: "local-model", label: "Local", auth: "api-key" }),
      entry({
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        label: "Spark",
        auth: "oauth",
        billing: "subscription",
      }),
    ];
    const credentials = [
      credential({ id: "hosted-connection", provider: "openai", label: "OpenAI" }),
      credential({ id: "local-connection", provider: "ollama", label: "Ollama" }),
      credential({
        id: "codex-connection",
        provider: "openai-codex",
        label: "Codex",
        modelId: "gpt-5.3-codex-spark",
      }),
    ];

    const options = connectedModelOptions(catalog, credentials);
    expect(options.map((option) => option.provider)).toEqual(["openai", "ollama"]);
    expect(options.map((option) => option.key)).toEqual([
      JSON.stringify(["openai", "hosted", "hosted-connection"]),
      JSON.stringify(["ollama", "local-model", "local-connection"]),
    ]);
  });
});
