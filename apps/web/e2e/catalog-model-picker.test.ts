import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import type { Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";

const assertions = vi.hoisted(() => ({ enabled: vi.fn(), visible: vi.fn(), text: vi.fn() }));
vi.mock("@playwright/test", () => ({
  expect: () => ({
    toBeEnabled: assertions.enabled,
    toBeVisible: assertions.visible,
    toHaveText: assertions.text,
  }),
}));

import { selectCatalogModel } from "./catalog-model-picker";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function fixture(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[] = [],
  { toggleVisible = false, optionVisible = true } = {},
) {
  const actions: string[] = [];
  let expanded = false;
  const fetch = vi.fn(async (url: string) =>
    Response.json({ json: url.endsWith("models/list") ? catalog : credentials }),
  );
  vi.stubGlobal("fetch", fetch);
  const directRequest = vi.fn(async () => {
    throw new Error("models/list 401: fixture routes were bypassed");
  });
  const selectOption = vi.fn();
  const optionClick = vi.fn(() => actions.push("option"));
  const fill = vi.fn(() => actions.push("search"));
  const check = vi.fn(() => {
    expanded = true;
    actions.push("show all");
  });
  assertions.enabled.mockImplementation(async () => {
    actions.push("ready");
  });
  const option = { click: optionClick, isVisible: async () => optionVisible || expanded };
  const picker = { click: vi.fn(() => actions.push("open")) };
  const search = { fill, press: vi.fn(() => actions.push("close")) };
  const page = {
    request: { post: directRequest },
    evaluate: async (fn: () => Promise<unknown>) => fn(),
    getByText: vi.fn(),
    getByRole: (_role: string, options?: { name?: string }) => {
      if (options?.name === "Show all models")
        return { isVisible: async () => toggleVisible, isChecked: async () => expanded, check };
      if (options?.name === "Choose connection") return { selectOption };
      if (options?.name === "Search models") return search;
      if (options?.name === "Model options") return { getByRole: () => ({ filter: () => option }) };
      return picker;
    },
  } as unknown as Page;
  return { page, fetch, directRequest, selectOption, optionClick, fill, check, actions };
}

it("reads the browser fixture and chooses the exact connection without a server request", async () => {
  const f = fixture(
    [
      { provider: "first", id: "model", label: "Shared", billing: "", auth: "api-key" },
      {
        provider: "gateway",
        id: "first/model",
        catalogId: "model",
        label: "Shared",
        billing: "",
        auth: "api-key",
      },
    ],
    [{ id: "saved", provider: "gateway", label: "Saved", hasKey: true, isDefault: false }],
  );
  await selectCatalogModel(f.page, "gateway", "first/model", "saved");
  expect(f.directRequest).not.toHaveBeenCalled();
  expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([
    "/rpc/models/list",
    "/rpc/models/credentials",
  ]);
  expect(f.fill).toHaveBeenCalledWith("Shared");
  expect(f.optionClick).toHaveBeenCalledOnce();
  expect(f.selectOption).toHaveBeenCalledWith(JSON.stringify(["gateway", "first/model", "saved"]));
  expect(f.actions).toEqual(["ready", "open", "search", "option"]);
  expect(f.check).not.toHaveBeenCalled();
});

it("reveals a missing short-list option by closing search and checking Show all models", async () => {
  const f = fixture([{ provider: "first", id: "model", label: "Model", billing: "" }], [], {
    toggleVisible: true,
    optionVisible: false,
  });
  await selectCatalogModel(f.page, "first", "model");
  expect(f.actions).toEqual([
    "ready",
    "open",
    "search",
    "close",
    "show all",
    "open",
    "search",
    "option",
  ]);
  expect(f.fill).toHaveBeenNthCalledWith(2, "Model");
});

it("reveals a plan-limited connection even when another connection exposes the shared row", async () => {
  const f = fixture(
    [
      {
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        label: "Spark",
        billing: "",
        auth: "api-key",
      },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        label: "Spark",
        billing: "",
        auth: "oauth",
      },
    ],
    [],
    { toggleVisible: true },
  );
  await selectCatalogModel(f.page, "openai-codex", "gpt-5.3-codex-spark");
  expect(f.actions).toEqual(["ready", "show all", "open", "search", "option"]);
  expect(f.selectOption).toHaveBeenCalledWith(
    JSON.stringify(["openai-codex", "gpt-5.3-codex-spark", null]),
  );
});

it("finds the saved demo model in public connection metadata", async () => {
  const f = fixture(
    [
      {
        provider: "openai-compatible",
        id: "custom",
        label: "Custom model id",
        placeholder: true,
        billing: "",
      },
    ],
    [
      {
        id: "demo",
        provider: "openai-compatible",
        label: "Demo fixture",
        modelId: "demo-fixture",
        baseUrl: "https://example.invalid/v1",
        hasKey: true,
        isDefault: true,
      },
    ],
  );
  await selectCatalogModel(f.page, "openai-compatible", "demo-fixture");
  expect(f.fill).toHaveBeenCalledWith("demo-fixture");
  expect(f.optionClick).toHaveBeenCalledOnce();
  expect(f.check).not.toHaveBeenCalled();
});

it("uses the short list's connection count when a shared model has a hidden connection", async () => {
  const f = fixture(
    [
      {
        provider: "openai",
        id: "gpt-5.3-codex-spark",
        label: "Spark",
        billing: "",
        auth: "api-key",
      },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        label: "Spark",
        billing: "",
        auth: "oauth",
      },
    ],
    [],
    { toggleVisible: true },
  );
  await selectCatalogModel(f.page, "openai", "gpt-5.3-codex-spark");
  expect(f.check).not.toHaveBeenCalled();
  expect(f.selectOption).not.toHaveBeenCalled();
  expect(f.optionClick).toHaveBeenCalledOnce();
});
