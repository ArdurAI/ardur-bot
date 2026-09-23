// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ me: vi.fn(), list: vi.fn(), signIn: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: { me: api.me, models: { list: api.list }, integrationSetup: { get: async () => null } },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
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
  vi.clearAllMocks();
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
