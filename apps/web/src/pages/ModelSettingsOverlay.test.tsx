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
  ollama: vi.fn(),
  testOllama: vi.fn(),
  connect: vi.fn(),
  availability: vi.fn(),
  connectCodex: vi.fn(),
  connectStatus: vi.fn(),
  cancelConnect: vi.fn(),
  persistenceChange: null as ((pending: boolean) => void) | null,
}));
vi.mock("../lib/rpc", () => ({ rpc: { models: api, me: api.me, runtimes: api } }));
vi.mock("../lib/use-model-oauth-signin", () => ({
  useModelOAuthSignIn: (options: { onPersistenceChange?: (pending: boolean) => void }) => {
    api.persistenceChange = options.onPersistenceChange ?? null;
    return {
      Select: (p: any) => <div {...p} />,
      SelectTrigger: (p: any) => <div {...p} />,
      SelectValue: (p: any) => <div {...p} />,
      SelectContent: (p: any) => <div {...p} />,
      SelectItem: (p: any) => <div {...p} />,
      SelectGroup: (p: any) => <div {...p} />,
      SelectLabel: (p: any) => <div {...p} />,
      SelectSeparator: (p: any) => <div {...p} />,
      oauth: null,
      pasteCode: "",
      setPasteCode: vi.fn(),
      oauthPending: false,
      cancelOAuthAttempt: vi.fn(),
      startSubscriptionSignIn: api.signIn,
      submitOAuthCode: vi.fn(),
    };
  },
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
    Select: (p: any) => <div {...p} />,
    SelectTrigger: (p: any) => <div {...p} />,
    SelectValue: (p: any) => <div {...p} />,
    SelectContent: (p: any) => <div {...p} />,
    SelectItem: (p: any) => <div {...p} />,
    SelectGroup: (p: any) => <div {...p} />,
    SelectLabel: (p: any) => <div {...p} />,
    SelectSeparator: (p: any) => <div {...p} />,
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
    ModelThinkingOptions: ({
      contextWindow,
      contextWindowLabel,
      onContextWindowChange,
    }: {
      contextWindow: string;
      contextWindowLabel: string;
      onContextWindowChange: (value: string) => void;
    }) => (
      <label>
        {contextWindowLabel}
        <input
          aria-label={contextWindowLabel}
          value={contextWindow}
          onChange={(event) => onContextWindowChange(event.target.value)}
        />
      </label>
    ),
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
  api.persistenceChange = null;
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

async function expandNativeRuntime() {
  await act(async () => {
    const panel = container.querySelector("details")!;
    panel.open = true;
    panel.dispatchEvent(new Event("toggle"));
  });
  await act(async () => {
    const panel = [...container.querySelectorAll("details")].find(
      (entry) => entry.querySelector("summary")?.textContent === "Codex",
    )!;
    panel.open = true;
    panel.dispatchEvent(new Event("toggle"));
  });
}

it("discovers native models without a bot or changing pins, and cancels owner setup", async () => {
  api.me.mockResolvedValue({
    isDeploymentOwner: true,
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6-sol",
  });
  api.availability.mockResolvedValue({
    runtimeKind: "codex-app-server",
    available: true,
    signedIn: false,
    models: [{ id: "native-fixture", label: "Native fixture", efforts: [] }],
  });
  api.connectCodex.mockResolvedValue({
    loginId: "login-fixture",
    verificationUri: "https://example.test/login",
  });
  api.cancelConnect.mockResolvedValue({ ok: true });
  await render();
  expect(api.availability).not.toHaveBeenCalled();
  await expandNativeRuntime();
  expect(api.availability).toHaveBeenCalledWith({
    runtimeKind: "codex-app-server",
    botId: undefined,
    refresh: false,
  });
  expect(container.textContent).toContain("Native fixture");
  expect(container.querySelector('[id$="-model"]')).toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((entry) => entry.textContent === "Connect")!
      .click(),
  );
  expect(container.querySelector('a[href="https://example.test/login"]')).not.toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((entry) => entry.textContent === "Cancel")!
      .click(),
  );
  expect(api.cancelConnect).toHaveBeenCalledWith({ loginId: "login-fixture" });
  expect(api.connect).not.toHaveBeenCalled();
});

it("does not expose native setup to a non-owner", async () => {
  api.availability.mockResolvedValue({ available: true, signedIn: false, models: [] });
  await render();
  await expandNativeRuntime();
  expect(container.textContent).toContain("Set up on the home device");
  expect(
    [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Connect"),
  ).toBeUndefined();
  expect(api.connectCodex).not.toHaveBeenCalled();
});

it("cancels a late native sign-in response after its panel is detached", async () => {
  api.me.mockResolvedValue({ isDeploymentOwner: true, defaultProvider: "openai-codex" });
  api.availability.mockResolvedValue({ available: true, signedIn: false, models: [] });
  let finish!: (value: unknown) => void;
  api.connectCodex.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  api.cancelConnect.mockResolvedValue({ ok: true });
  await render();
  await expandNativeRuntime();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((entry) => entry.textContent === "Connect")!
      .click(),
  );
  await act(async () => {
    const panel = [...container.querySelectorAll("details")].find(
      (entry) => entry.querySelector("summary")?.textContent === "Codex",
    )!;
    panel.open = false;
    panel.dispatchEvent(new Event("toggle"));
  });
  await act(async () =>
    finish({ loginId: "late-login", verificationUri: "https://example.test/login" }),
  );
  expect(api.cancelConnect).toHaveBeenCalledWith({ loginId: "late-login" });
  expect(container.querySelector('a[href="https://example.test/login"]')).toBeNull();
});

it("reports subscription persistence through the overlay handoff", async () => {
  const onSavePendingChange = vi.fn();
  await act(async () =>
    root.render(
      <ModelSettingsOverlay
        embedded
        onClose={() => undefined}
        onSavePendingChange={onSavePendingChange}
      />,
    ),
  );
  onSavePendingChange.mockClear();
  await act(async () => api.persistenceChange?.(true));
  expect(onSavePendingChange).toHaveBeenLastCalledWith(true);
  await act(async () => api.persistenceChange?.(false));
  expect(onSavePendingChange).toHaveBeenLastCalledWith(false);
});

it("reports an Ollama connection save through the overlay handoff", async () => {
  let finish!: (value: { id: string }) => void;
  api.list.mockResolvedValue([
    ...catalog,
    {
      provider: "ollama",
      providerName: "Ollama",
      id: "local",
      label: "Local",
      billing: "",
      auth: "api-key",
    },
  ]);
  api.ollama.mockResolvedValue({ baseUrl: "http://127.0.0.1:11434", models: [], canPull: true });
  api.testOllama.mockResolvedValue({
    baseUrl: "http://127.0.0.1:11434",
    models: [],
    canPull: true,
    version: "test",
  });
  api.connect.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onSavePendingChange = vi.fn();
  await act(async () =>
    root.render(
      <ModelSettingsOverlay
        embedded
        onClose={() => undefined}
        onSavePendingChange={onSavePendingChange}
      />,
    ),
  );
  await act(async () => button("Ollama").click());
  await act(async () => button("Test").click());
  onSavePendingChange.mockClear();
  await act(async () => button("Save").click());
  expect(onSavePendingChange).toHaveBeenLastCalledWith(true);
  await act(async () => finish({ id: "connection" }));
  expect(onSavePendingChange).toHaveBeenLastCalledWith(false);
});

it.each([false, true])(
  "offers only an API key for Anthropic (reconnect: %s)",
  async (reconnect) => {
    api.list.mockResolvedValue([
      {
        provider: "anthropic",
        providerName: "Anthropic",
        id: "claude-opus-5",
        label: "Claude Opus 5",
        auth: "api-key",
        subscription: false,
        billing: "Uses your Anthropic API key.",
      },
    ]);
    api.me.mockResolvedValue({ defaultProvider: "anthropic", defaultModel: "claude-opus-5" });
    api.credentials.mockResolvedValue(
      reconnect
        ? [
            {
              id: "credential",
              provider: "anthropic",
              label: "Old subscription",
              hasKey: false,
              isDefault: true,
              connectionIssue: "api-key-required",
            },
          ]
        : [],
    );
    const onOpenBotRuntime = vi.fn();
    await act(async () =>
      root.render(
        <ModelSettingsOverlay
          embedded
          onClose={() => undefined}
          onOpenBotRuntime={onOpenBotRuntime}
        />,
      ),
    );
    await act(async () => button("Open bot settings").click());
    expect(onOpenBotRuntime).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Set up on the home device");
    expect(container.querySelector('label[for="model-api-key"]')?.textContent).toContain("API key");
    expect(container.textContent).not.toContain("Sign in");
    expect(container.textContent).not.toContain("Connected ·");
    if (reconnect) {
      expect(container.textContent).toContain("Reconnect with an API key");
      expect(container.textContent).not.toContain("Stored securely");
      expect(button("Connect API key")).toBeDefined();
    }
  },
);
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

it("opens the provider requested by a pin failure instead of the space default", async () => {
  api.list.mockResolvedValue([
    ...catalog,
    {
      provider: "xai",
      providerName: "xAI",
      id: "grok-4.6",
      label: "Grok 4.6",
      auth: "api-key",
      billing: "",
    },
  ]);
  await act(async () =>
    root.render(<ModelSettingsOverlay embedded initialProvider="xai" onClose={() => undefined} />),
  );
  expect(picker().textContent).toBe("Grok 4.6");
});

it.each([
  ["default", 65_536, "Context limit (estimated)"],
  ["catalog", 200_000, "Context limit (from the provider)"],
  ["metadata", 8_192, "Context limit"],
] as const)(
  "shows the resolved %s context in Models",
  async (contextWindowSource, contextWindow, label) => {
    api.list.mockResolvedValue([
      {
        provider: "openai-compatible",
        providerName: "OpenAI-compatible",
        id: "custom",
        label: "Custom model id",
        billing: "",
        auth: "api-key",
        placeholder: true,
      },
    ]);
    api.credentials.mockResolvedValue([
      {
        id: "connection",
        provider: "openai-compatible",
        label: "Fixture",
        hasKey: true,
        isDefault: true,
        modelId: "fixture-model",
        baseUrl: "https://example.invalid/v1",
        contextWindow,
        contextWindowSource,
      },
    ]);
    api.me.mockResolvedValue({
      defaultProvider: "openai-compatible",
      defaultModel: "fixture-model",
    });
    await render();
    expect(container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.value).toBe(
      String(contextWindow),
    );
    expect(container.textContent).toContain(label);
  },
);

it("does not turn an untouched estimate into saved metadata when reconnecting", async () => {
  api.list.mockResolvedValue([
    {
      provider: "openai-compatible",
      providerName: "OpenAI-compatible",
      id: "custom",
      label: "Custom model id",
      billing: "",
      auth: "api-key",
      placeholder: true,
    },
  ]);
  api.credentials.mockResolvedValue([
    {
      id: "connection",
      provider: "openai-compatible",
      label: "Fixture",
      hasKey: true,
      isDefault: true,
      modelId: "fixture-model",
      baseUrl: "https://example.invalid/v1",
      contextWindow: 65_536,
      contextWindowSource: "default",
    },
  ]);
  api.me.mockResolvedValue({ defaultProvider: "openai-compatible", defaultModel: "fixture-model" });
  api.connect.mockResolvedValue({});
  await render();
  const connect = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === "Save",
  );
  expect(connect).toBeDefined();
  await act(async () => connect!.click());
  expect(api.connect).toHaveBeenCalled();
  expect(api.connect.mock.calls[0]?.[0]).not.toHaveProperty("contextWindow");
});
