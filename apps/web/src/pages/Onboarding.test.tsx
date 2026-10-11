// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
  credentials: vi.fn(),
  setDefault: vi.fn(),
  connect: vi.fn(),
  cancelSignIn: vi.fn(),
  signIn: vi.fn(),
  create: vi.fn(),
  start: vi.fn(),
  promptFocus: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => null,
  rpc: {
    me: api.me,
    models: {
      list: api.list,
      credentials: api.credentials,
      setDefault: api.setDefault,
      connect: api.connect,
    },
    integrationSetup: { get: async () => null },
    bots: { list: async () => [], create: api.create },
    onboarding: { start: api.start, promptFocus: api.promptFocus },
  },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => api.navigate }));
vi.mock("../components/integrations/IntegrationSetup", () => ({ IntegrationSetup: () => null }));
vi.mock("../lib/use-model-oauth-signin", () => ({
  useModelOAuthSignIn: () => ({
    cancelOAuthAttempt: api.cancelSignIn,
    startSubscriptionSignIn: api.signIn,
  }),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value }: { value: number }) => `${value} models`,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Select: ({
    value,
    onValueChange,
    items,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    items: { value: string; label: string }[];
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
  ModelThinkingOptions: () => null,
}));

import { OnboardingPage } from "./Onboarding";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  api.me.mockResolvedValue({ needsModel: false });
  api.list.mockResolvedValue([]);
  api.credentials.mockResolvedValue([]);
  api.setDefault.mockResolvedValue({ ok: true });
  api.create.mockResolvedValue({ id: "first-bot" });
  api.start.mockResolvedValue(undefined);
  api.promptFocus.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "passes the recommendation into OAuth on initial load or provider switch (%s)",
  async (switchProvider) => {
    const codex = ["gpt-5.3-codex-spark", "gpt-6-sol", "gpt-6-astra"].map((id) => ({
      provider: "openai-codex",
      id,
      label: id,
      billing: "",
      auth: "oauth",
      signIn: "device-code",
    }));
    api.list.mockResolvedValue([
      { provider: "scripted", id: "scripted", label: "Scripted", auth: "api-key", billing: "" },
      ...codex,
    ]);
    api.me.mockResolvedValue({
      needsModel: true,
      defaultProvider: switchProvider ? "scripted" : "openai-codex",
      defaultModel: null,
    });
    await act(async () => root.render(<OnboardingPage />));
    await act(async () => await vi.dynamicImportSettled());
    if (switchProvider) {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!.click(),
      );
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
          .find((option) => option.textContent?.startsWith("gpt-6-astra"))!
          .click(),
      );
    }
    const signIn = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Sign in",
    );
    expect(signIn).toBeDefined();
    await act(async () => signIn?.click());
    expect(api.signIn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-codex", modelId: "gpt-6-astra" }),
    );
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function retryButton() {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
}

it.each(["account", "catalog"] as const)(
  "a failed %s read never creates a bot and retry recovers",
  async (failed) => {
    const read = failed === "account" ? api.me : api.list;
    read.mockRejectedValueOnce(new Error("unreachable"));
    await act(async () => root.render(<OnboardingPage />));
    expect(api.create).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      failed === "account" ? "Could not load setup." : "Could not load models.",
    );
    expect(container.textContent).not.toContain("unreachable");
    expect(container.querySelector("select")).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.navigate).not.toHaveBeenCalled();
    await act(async () => retryButton().click());
    expect(api.me).toHaveBeenCalledTimes(2);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.navigate).toHaveBeenCalledWith("/app/first-bot");
  },
);

it("retry recovers to model selection when the confirmed account needs a model", async () => {
  api.me.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ needsModel: true });
  api.list.mockResolvedValue([
    { provider: "scripted", id: "scripted", label: "Scripted", auth: "api-key", billing: "" },
  ]);
  await act(async () => root.render(<OnboardingPage />));
  await act(async () => retryButton().click());
  expect(container.querySelector("h1")?.textContent).toBe("Connect a model");
  expect(api.create).not.toHaveBeenCalled();
});

it.each(["account", "catalog"] as const)(
  "a deferred %s read stays loading until confirmed",
  async (pending) => {
    const response = deferred<unknown>();
    (pending === "account" ? api.me : api.list).mockReturnValueOnce(response.promise);
    await act(async () => root.render(<OnboardingPage />));
    expect(container.textContent).toContain("Loading…");
    expect(api.create).not.toHaveBeenCalled();
    await act(async () => response.resolve(pending === "account" ? { needsModel: false } : []));
    expect(api.create).toHaveBeenCalledTimes(1);
  },
);

it("repeated retry clicks start one read and wait for it", async () => {
  api.me.mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<OnboardingPage />));
  const response = deferred<unknown>();
  api.me.mockReturnValueOnce(response.promise);
  const retry = retryButton();
  await act(async () => {
    retry.click();
    retry.click();
  });
  expect(api.me).toHaveBeenCalledTimes(2);
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Loading…");
  expect(api.create).not.toHaveBeenCalled();
  await act(async () => response.resolve({ needsModel: false }));
  expect(api.create).toHaveBeenCalledTimes(1);
});

it.each(["resolve", "reject"] as const)("ignores reads that %s after unmount", async (settle) => {
  const response = deferred<unknown>();
  api.me.mockReturnValueOnce(response.promise);
  await act(async () => root.render(<OnboardingPage />));
  await act(async () => root.unmount());
  await act(async () => {
    if (settle === "resolve") response.resolve({ needsModel: false });
    else response.reject(new Error("offline"));
  });
  expect(container.childNodes).toHaveLength(0);
  expect(api.create).not.toHaveBeenCalled();
  expect(api.navigate).not.toHaveBeenCalled();
});

it("ignores a stale read when Strict Mode restarts the mount effect", async () => {
  const stale = deferred<unknown>();
  api.me.mockReturnValueOnce(stale.promise).mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    root.render(
      <StrictMode>
        <OnboardingPage />
      </StrictMode>,
    ),
  );
  expect(container.textContent).toContain("Could not load setup.");
  await act(async () => stale.resolve({ needsModel: false }));
  expect(container.textContent).toContain("Could not load setup.");
  expect(api.create).not.toHaveBeenCalled();
});

it("does not navigate or continue onboarding after unmount during bot creation", async () => {
  const response = deferred<{ id: string }>();
  api.create.mockReturnValueOnce(response.promise);
  await act(async () => root.render(<OnboardingPage />));
  expect(api.create).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  await act(async () => response.resolve({ id: "first-bot" }));
  expect(api.start).not.toHaveBeenCalled();
  expect(api.navigate).not.toHaveBeenCalled();
});

it("ignores a retry response after unmount", async () => {
  api.me.mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<OnboardingPage />));
  const response = deferred<unknown>();
  api.me.mockReturnValueOnce(response.promise);
  await act(async () => retryButton().click());
  await act(async () => root.unmount());
  await act(async () => response.resolve({ needsModel: false }));
  expect(api.create).not.toHaveBeenCalled();
  expect(api.navigate).not.toHaveBeenCalled();
});

async function chooseModel(label: string) {
  await act(async () => await vi.dynamicImportSettled());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!.click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.startsWith(label))!
      .click(),
  );
}

it.each(["api-key", "oauth"] as const)(
  "uses a saved personal %s connection without asking for a key or sign-in",
  async (auth) => {
    api.me.mockResolvedValue({ needsModel: true });
    api.list.mockResolvedValue([
      {
        provider: "fixture",
        id: "model",
        label: "Model",
        billing: "",
        auth,
        ...(auth === "oauth" ? { signIn: "device-code" } : {}),
      },
    ]);
    api.credentials.mockResolvedValue([
      {
        id: "saved",
        provider: "fixture",
        label: "Saved",
        hasKey: true,
        oauth: auth === "oauth",
        isDefault: false,
      },
    ]);
    await act(async () => root.render(<OnboardingPage />));
    await chooseModel("Model");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Use this model")!
        .click(),
    );
    expect(api.setDefault).toHaveBeenCalledWith({
      provider: "fixture",
      modelId: "model",
      credentialId: "saved",
    });
    expect(api.connect).not.toHaveBeenCalled();
    expect(api.signIn).not.toHaveBeenCalled();
    expect(api.create).toHaveBeenCalledOnce();
  },
);

it("waits for an explicit connection choice when two providers serve the model", async () => {
  api.me.mockResolvedValue({ needsModel: true });
  api.list.mockResolvedValue([
    { provider: "one", id: "model", label: "Shared", billing: "", auth: "api-key" },
    {
      provider: "two",
      id: "one/model",
      catalogId: "model",
      label: "Shared",
      billing: "",
      auth: "api-key",
    },
  ]);
  api.credentials.mockResolvedValue([
    { id: "saved", provider: "two", label: "Saved", hasKey: true, isDefault: false },
  ]);
  await act(async () => root.render(<OnboardingPage />));
  await chooseModel("Shared");
  expect(api.setDefault).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Choose connection"]',
  )!;
  const option = [...select.options].find((option) => option.textContent?.includes("Saved"))!;
  await act(async () => {
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use this model")!
      .click(),
  );
  expect(api.setDefault).toHaveBeenCalledWith({
    provider: "two",
    modelId: "one/model",
    credentialId: "saved",
  });
});

it("cancels the pending sign-in when a different model is selected", async () => {
  api.me.mockResolvedValue({ needsModel: true });
  api.list.mockResolvedValue([
    {
      provider: "signed",
      id: "signed",
      label: "Signed",
      billing: "",
      auth: "oauth",
      signIn: "device-code",
    },
    { provider: "other", id: "other", label: "Other", billing: "", auth: "api-key" },
  ]);
  await act(async () => root.render(<OnboardingPage />));
  await chooseModel("Signed");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Sign in")!
      .click(),
  );
  api.cancelSignIn.mockClear();
  await chooseModel("Other");
  expect(api.cancelSignIn).toHaveBeenCalledOnce();
  expect(api.create).not.toHaveBeenCalled();
  expect(api.setDefault).not.toHaveBeenCalled();
});

it("keeps setup on the selected model when default validation fails", async () => {
  api.me.mockResolvedValue({ needsModel: true });
  api.list.mockResolvedValue([
    { provider: "fixture", id: "model", label: "Model", billing: "", auth: "api-key" },
  ]);
  api.credentials.mockResolvedValue([
    { id: "saved", provider: "fixture", label: "Saved", hasKey: true, isDefault: false },
  ]);
  api.setDefault.mockRejectedValue(new Error("This connection cannot serve that model."));
  await act(async () => root.render(<OnboardingPage />));
  await chooseModel("Model");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use this model")!
      .click(),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This connection cannot serve that model.",
  );
  expect(api.create).not.toHaveBeenCalled();
});

it("keeps Continue visible and disabled when the loaded catalog is empty", async () => {
  api.me.mockResolvedValue({ needsModel: true });
  await act(async () => root.render(<OnboardingPage />));
  await act(async () => await vi.dynamicImportSettled());
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Continue",
  );
  expect(button).toBeDefined();
  expect(button?.disabled).toBe(true);
  expect(api.connect).not.toHaveBeenCalled();
  expect(api.create).not.toHaveBeenCalled();
});
