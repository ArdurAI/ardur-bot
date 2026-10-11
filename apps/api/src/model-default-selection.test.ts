import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import { MODEL_ID_MAX_LENGTH } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import { modelDefaultSelectionIssue } from "./model-default-selection.js";

const credential: ModelCredential = {
  id: "connection",
  provider: "fixture",
  label: "Fixture",
  hasKey: true,
  isDefault: false,
};
const catalog: ModelCatalogEntry[] = [
  { provider: "fixture", id: "model", label: "Model", billing: "", auth: "api-key" },
];
it("checks catalog compatibility, credentials and endpoint metadata before saving", () => {
  expect(modelDefaultSelectionIssue("fixture", "model", credential, catalog)).toBeUndefined();
  for (const choice of [
    { provider: "other" },
    { hasKey: false },
    { connectionIssue: "api-key-required" as const },
    { oauth: true },
  ]) {
    expect(
      modelDefaultSelectionIssue("fixture", "model", { ...credential, ...choice }, catalog),
    ).toBeDefined();
  }
  expect(modelDefaultSelectionIssue("fixture", "unknown", credential, catalog)).toBeUndefined();
  expect(modelDefaultSelectionIssue("fixture", null, credential, catalog)).toBeDefined();
  expect(
    modelDefaultSelectionIssue(
      "openai-compatible",
      "custom",
      { ...credential, provider: "openai-compatible" },
      catalog,
    ),
  ).toBeDefined();
  expect(
    modelDefaultSelectionIssue(
      "openai-compatible",
      "custom",
      { ...credential, provider: "openai-compatible", baseUrl: "https://example.invalid/v1" },
      catalog,
    ),
  ).toBeUndefined();
  expect(
    modelDefaultSelectionIssue("signed", "model", { ...credential, provider: "signed" }, [
      { ...catalog[0]!, provider: "signed", auth: "oauth" },
    ]),
  ).toBeDefined();
});

it.each(["copy-provider", "provider-a", "openai", "openrouter"])(
  "accepts an explicit API model outside the catalog for %s",
  (provider) => {
    expect(
      modelDefaultSelectionIssue(
        provider,
        "vendor/fine-tuned-model",
        { ...credential, provider },
        catalog,
      ),
    ).toBeUndefined();
  },
);
it("keeps sign-in-only provider validation for uncatalogued ids", () => {
  expect(
    modelDefaultSelectionIssue("signed", "custom", { ...credential, provider: "signed" }, [
      { ...catalog[0]!, provider: "signed", auth: "oauth" },
    ]),
  ).toBe("This connection cannot serve that model.");
});

it.each(["fixture", "openai-compatible", "ollama"])(
  "bounds custom ids before catalog or server shortcuts for %s",
  (provider) => {
    const connection = { ...credential, provider, baseUrl: "https://example.invalid/v1" };
    for (const modelId of [
      "m".repeat(MODEL_ID_MAX_LENGTH + 1),
      "vendor/\u0000model",
      "vendor/\tmodel",
      "vendor/\nmodel",
      "\nmodel",
      "model\r",
      "vendor/\u007fmodel",
      "vendor/\u0085model",
    ]) {
      expect(modelDefaultSelectionIssue(provider, modelId, connection, catalog)).toBe(
        "Choose a model.",
      );
    }
    for (const modelId of ["vendor/custom-model:latest", "m".repeat(MODEL_ID_MAX_LENGTH)]) {
      expect(modelDefaultSelectionIssue(provider, modelId, connection, catalog)).toBeUndefined();
    }
  },
);
