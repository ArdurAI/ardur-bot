import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  HERMES_CONTEXT_LIMIT_MESSAGE,
  modelContextWindowLabel,
  resolveModelContextWindow,
} from "./domain.js";

describe("connection context resolution", () => {
  it.each([
    [32_768, 200_000, 32_768, "metadata"],
    [undefined, 200_000, 200_000, "catalog"],
    [undefined, 2_000_000, 2_000_000, "catalog"],
    [undefined, undefined, 65_536, "default"],
    [0, 200_000, 200_000, "catalog"],
    [Number.NaN, undefined, 65_536, "default"],
    [undefined, -1, 65_536, "default"],
  ] as const)(
    "resolves metadata %s and catalog %s",
    (metadata, catalog, contextWindow, contextWindowSource) => {
      expect(resolveModelContextWindow(metadata, catalog)).toEqual({
        contextWindow,
        contextWindowSource,
      });
    },
  );

  it("does not raise the built-in delegation reservation cap", () => {
    expect(DEFAULT_MODEL_CONTEXT_WINDOW).toBe(32_768);
  });
});

it("keeps the pin-time refusal exact", () => {
  expect(HERMES_CONTEXT_LIMIT_MESSAGE).toBe(
    "Hermes needs a context limit of at least 64K tokens. Set it for this connection in Settings → Models.",
  );
});

it.each([
  ["default", "Context limit (estimated)"],
  ["catalog", "Context limit (from the provider)"],
  ["metadata", "Context limit"],
] as const)("labels the %s source", (source, label) => {
  expect(modelContextWindowLabel(source)).toBe(label);
});
