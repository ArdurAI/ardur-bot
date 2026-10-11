import type { Page } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@playwright/test", () => ({
  expect: () => ({ toBeVisible: async () => {}, toHaveText: async () => {} }),
}));

import { selectCatalogModel } from "./catalog-model-picker";

afterEach(() => vi.unstubAllGlobals());
it("reads the browser fixture and chooses the exact connection without a server request", async () => {
  const catalog = [
    { provider: "first", id: "model", label: "Shared", billing: "", auth: "api-key" },
    {
      provider: "gateway",
      id: "first/model",
      catalogId: "model",
      label: "Shared",
      billing: "",
      auth: "api-key",
    },
  ];
  const credentials = [
    { id: "saved", provider: "gateway", label: "Saved", hasKey: true, isDefault: false },
  ];
  const fetch = vi.fn(async (url: string) =>
    Response.json({ json: url.endsWith("models/list") ? catalog : credentials }),
  );
  vi.stubGlobal("fetch", fetch);
  const directRequest = vi.fn(async () => {
    throw new Error("models/list 401: fixture routes were bypassed");
  });
  const selectOption = vi.fn();
  const optionClick = vi.fn();
  const fill = vi.fn();
  const page = {
    request: { post: directRequest },
    evaluate: async (fn: () => Promise<unknown>) => fn(),
    getByText: vi.fn(),
    getByRole: (_role: string, options?: { name?: string }) =>
      options?.name === "Show all models"
        ? { isVisible: async () => false }
        : options?.name === "Choose connection"
          ? { selectOption }
          : { click: vi.fn(), fill, filter: () => ({ click: optionClick }) },
  } as unknown as Page;
  await selectCatalogModel(page, "gateway", "first/model", "saved");
  expect(directRequest).not.toHaveBeenCalled();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/rpc/models/list",
    "/rpc/models/credentials",
  ]);
  expect(fill).toHaveBeenCalledWith("Shared");
  expect(optionClick).toHaveBeenCalledOnce();
  expect(selectOption).toHaveBeenCalledWith(JSON.stringify(["gateway", "first/model", "saved"]));
});
