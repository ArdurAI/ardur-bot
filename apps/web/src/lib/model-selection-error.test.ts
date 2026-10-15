import { expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => `translated: ${parts.join("")}`,
}));

import { modelSelectionErrorMessage } from "./model-selection-error";

it.each([
  "Connect that model first.",
  "Choose a model.",
  "Connect that model server first.",
  "This connection cannot serve that model.",
  "Unknown model for that provider",
])("translates the known selection refusal: %s", (message) => {
  expect(modelSelectionErrorMessage(new Error(message), "fallback")).toBe(`translated: ${message}`);
});

it("preserves other server diagnostics and uses the fallback for non-errors", () => {
  expect(modelSelectionErrorMessage(new Error("Server unreachable"), "fallback")).toBe(
    "Server unreachable",
  );
  expect(modelSelectionErrorMessage(null, "fallback")).toBe("fallback");
});
