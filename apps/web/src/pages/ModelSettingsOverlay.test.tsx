// @vitest-environment jsdom

import type { ModelCatalogEntry } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  credentials: vi.fn(),
  me: vi.fn(),
  signIn: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { models: api, me: api.me } }));
vi.mock("../lib/use-model-oauth-signin", () => ({
  useModelOAuthSignIn: () => ({
    oauth: null,
    pasteCode: "",
    setPasteCode: vi.fn(),
    oauthPending: false,
    cancelOAuthAttempt: vi.fn(),
    startSubscriptionSignIn: api.signIn,
    submitOAuthCode: vi.fn(),
  }),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value }: { value: number }) => `${value} models`,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    ModelThinkingOptions: () => null,
  };
});

import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "openai-codex",
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    billing: "",
    auth: "oauth",
    signIn: "device-code",
    providerName: "OpenAI Codex",
  },
  {
    provider: "openai-codex",
    id: "gpt-5.5",
    label: "GPT-5.5",
    billing: "",
    auth: "oauth",
    signIn: "device-code",
    providerName: "OpenAI Codex",
  },
  {
    provider: "openai-codex",
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    billing: "",
    auth: "oauth",
    signIn: "device-code",
    providerName: "OpenAI Codex",
  },
  {
    provider: "openai-codex",
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    billing: "",
    auth: "oauth",
    signIn: "device-code",
    providerName: "OpenAI Codex",
  },
];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  api.list.mockResolvedValue(catalog);
  api.credentials.mockResolvedValue([]);
  api.me.mockResolvedValue({ defaultProvider: "openai-codex", defaultModel: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () => root.render(<ModelSettingsOverlay embedded onClose={() => undefined} />));
function picker() {
  const element = container.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Model"]',
  );
  if (!element) throw new Error("Missing model picker");
  return element;
}
function button(text: string) {
  const element = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes(text),
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

it("selects the recommendation on load and passes it to subscription sign-in", async () => {
  await render();
  expect(picker().textContent).toBe("GPT-6 Astra");
  const signIn = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Sign in",
  );
  expect(signIn).toBeDefined();
  await act(async () => signIn?.click());
  expect(api.signIn).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "openai-codex", modelId: "gpt-6-astra" }),
  );
});

it("hides Spark and orders all recommendations before lower preferences", async () => {
  await render();
  expect(button("OpenAI Codex").textContent).toContain("3 models");
  await act(async () => picker().click());
  expect(
    [...container.querySelectorAll('[role="option"]')].map((element) => element.textContent),
  ).toEqual(["GPT-6 Astra", "GPT-6 Sol", "GPT-5.5"]);
});

it("replaces a stored unavailable default in the picker", async () => {
  api.me.mockResolvedValue({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.3-codex-spark",
  });
  await render();
  expect(picker().textContent).toBe("GPT-6 Astra");
});

it("preserves a supported saved choice", async () => {
  api.me.mockResolvedValue({ defaultProvider: "openai-codex", defaultModel: "gpt-6-sol" });
  await render();
  expect(picker().textContent).toBe("GPT-6 Sol");
});

it("uses the recommendation when switching providers", async () => {
  api.list.mockResolvedValue([
    { provider: "scripted", id: "scripted", label: "Scripted", billing: "", auth: "api-key" },
    ...catalog,
  ]);
  api.me.mockResolvedValue({ defaultProvider: "scripted", defaultModel: "scripted" });
  await render();
  await act(async () => button("OpenAI Codex").click());
  expect(picker().textContent).toBe("GPT-6 Astra");
});

it.each(["api-key", "both"] as const)("keeps Spark available for %s auth", async (auth) => {
  api.list.mockResolvedValue(catalog.map((entry) => ({ ...entry, auth })));
  api.me.mockResolvedValue({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.3-codex-spark",
  });
  await render();
  expect(picker().textContent).toBe("GPT-5.3 Codex Spark");
  await act(async () => picker().click());
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(4);
});

it("reveals a selectable subscription model with a muted plan hint", async () => {
  await render();
  const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(toggle?.parentElement?.textContent).toBe("Show all models");
  await act(async () => toggle?.click());
  await act(async () => picker().click());
  const spark = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (option) => option.textContent?.includes("GPT-5.3 Codex Spark"),
  );
  expect(spark?.textContent).toContain("May not be available on your plan");
  expect(spark?.querySelector(".text-muted-foreground")).not.toBeNull();
  await act(async () => spark?.click());
  expect(picker().textContent).toBe("GPT-5.3 Codex Spark");
  await act(async () => toggle?.click());
  expect(picker().textContent).toBe("GPT-5.3 Codex Spark");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((entry) => entry.textContent === "Sign in")
      ?.click(),
  );
  expect(api.signIn).toHaveBeenCalledWith(
    expect.objectContaining({ modelId: "gpt-5.3-codex-spark" }),
  );
});

it("can reveal a provider whose entire catalog is hidden", async () => {
  api.list.mockResolvedValue([catalog[0]]);
  await render();
  const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(toggle).not.toBeNull();
  await act(async () => toggle?.click());
  expect(picker().textContent).toBe("GPT-5.3 Codex Spark");
});
