// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  list: vi.fn(),
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
    models: { list: api.list },
    integrationSetup: { get: async () => null },
    bots: { list: async () => [], create: api.create },
    onboarding: { start: api.start, promptFocus: api.promptFocus },
  },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => api.navigate }));
vi.mock("../components/integrations/IntegrationSetup", () => ({ IntegrationSetup: () => null }));
vi.mock("../lib/use-model-oauth-signin", () => ({
  useModelOAuthSignIn: () => ({ cancelOAuthAttempt: vi.fn(), startSubscriptionSignIn: api.signIn }),
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
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
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
    if (switchProvider)
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = "openai-codex";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
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
