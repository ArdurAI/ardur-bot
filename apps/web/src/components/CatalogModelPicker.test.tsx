// @vitest-environment jsdom
import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value }: { value: number }) => `${value} models`,
}));

import CatalogModelPicker from "./CatalogModelPicker";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onChange = vi.fn();
const custom: ModelCatalogEntry = {
  provider: "openai-compatible",
  id: "custom",
  label: "Custom model id",
  billing: "",
  placeholder: true,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  container.style.overflow = "hidden";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  catalog: ModelCatalogEntry[],
  credentials: ModelCredential[] = [],
  disabled = false,
) {
  await act(async () =>
    root.render(
      <CatalogModelPicker
        catalog={catalog}
        credentials={credentials}
        provider="openai-compatible"
        modelId=""
        onChange={onChange}
        disabled={disabled}
      />,
    ),
  );
}
const picker = () => container.querySelector<HTMLButtonElement>('[aria-label="Model"]')!;
const search = () => document.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
async function searchFor(query: string) {
  await act(async () => picker().click());
  await act(async () => {
    await vi.waitFor(() => expect(document.activeElement).toBe(search()));
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search(),
      query,
    );
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];

it("shows one Nova 2 Lite row and requires its exact connection", async () => {
  await render([
    {
      provider: "amazon-bedrock",
      id: "amazon.nova-2-lite-v1:0",
      catalogId: "amazon/nova-2-lite",
      label: "Nova 2 Lite",
      billing: "",
    },
    {
      provider: "vercel-ai-gateway",
      id: "amazon/nova-2-lite",
      label: "Nova 2 Lite",
      billing: "",
    },
  ]);
  await searchFor("Nova 2 Lite");
  expect(options()).toHaveLength(1);
  await act(async () => options()[0]!.click());
  expect(onChange).toHaveBeenCalledWith(null);
  const chooser = container.querySelector<HTMLSelectElement>('[aria-label="Choose connection"]')!;
  expect([...chooser.options].slice(1).map((option) => option.value)).toEqual([
    JSON.stringify(["amazon-bedrock", "amazon.nova-2-lite-v1:0", null]),
    JSON.stringify(["vercel-ai-gateway", "amazon/nova-2-lite", null]),
  ]);
  await act(async () => {
    chooser.value = chooser.options[2]!.value;
    chooser.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      entry: expect.objectContaining({ provider: "vercel-ai-gateway", id: "amazon/nova-2-lite" }),
    }),
  );
});

it("finds a saved demo model from connection metadata without Show all models", async () => {
  await render(
    [custom],
    [
      {
        id: "demo-connection",
        provider: "openai-compatible",
        label: "Demo fixture",
        modelId: "demo-fixture",
        baseUrl: "https://example.invalid/v1",
        hasKey: true,
        isDefault: true,
      },
    ],
  );
  await searchFor("demo-fixture");
  expect(options()).toHaveLength(1);
  expect(options()[0]?.textContent).toBe("demo-fixtureReady");
  await act(async () => options()[0]!.click());
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      entry: expect.objectContaining({ id: "demo-fixture", credentialId: "demo-connection" }),
      credential: expect.objectContaining({ id: "demo-connection" }),
      requirement: "ready",
    }),
  );
});

it("places custom entry outside the clipping pane and keeps search focus and selection", async () => {
  await render([custom]);
  await searchFor("Custom model id");
  const option = options()[0]!;
  expect(option.disabled).toBe(false);
  expect(container.contains(option)).toBe(false);
  expect(option.closest('[data-slot="popover-content"]')).not.toBeNull();
  expect(document.activeElement).toBe(search());
  await act(async () => option.click());
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({
      entry: custom,
      requirement: "local-server",
    }),
  );
  expect(picker().getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(picker());
});

it("reveals a plan-limited option through the checkbox before searching again", async () => {
  await render([
    custom,
    {
      provider: "openai-codex",
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
      auth: "oauth",
      billing: "",
    },
  ]);
  await searchFor("GPT-5.3 Codex Spark");
  expect(options()).toHaveLength(0);
  await act(async () =>
    search().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await act(async () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await searchFor("GPT-5.3 Codex Spark");
  expect(options()).toHaveLength(1);
  expect(options()[0]?.textContent).toContain("May not be available on your plan");
});

it("closes the portaled menu when model selection becomes disabled", async () => {
  await render([custom]);
  await searchFor("Custom model id");
  expect(options()).toHaveLength(1);
  await render([custom], [], true);
  expect(picker().disabled).toBe(true);
  expect(options()).toHaveLength(0);
  await act(async () => picker().click());
  expect(options()).toHaveLength(0);
  expect(onChange).not.toHaveBeenCalled();
});
