// @vitest-environment jsdom
import type { ActionAutoReviewSettings } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalRulesSettings } from "./ApprovalRulesSettings";

const get = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({
  rpc: {
    autoReview: { get },
    approvalRules: { list: async () => [] },
    bots: { list: async () => [] },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@ardurbot/ui-web", () => ({
  Label: ({ htmlFor, children }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Button: ({ variant: _v, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Switch: ({ checked, disabled }: { checked: boolean; disabled: boolean }) => (
    <input type="checkbox" checked={checked} disabled={disabled} readOnly />
  ),
}));
afterEach(() => vi.unstubAllGlobals());

it.each([true, false])(
  "shows the Jev warning even with an available fallback and enabled=%s",
  async (enabled) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const status: ActionAutoReviewSettings = {
      enabled,
      checkerAvailable: true,
      configurationWarning: "jev-key-missing",
    };
    get.mockResolvedValue(status);
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () => root.render(<ApprovalRulesSettings />));
    expect(node.querySelector('[role="status"]')?.textContent).toBe(
      "Jev needs a TypeSafe API key.",
    );
    expect(node.textContent).not.toContain("Add a model");
    expect(node.querySelector<HTMLInputElement>("input")?.checked).toBe(enabled);
    await act(async () => root.unmount());
  },
);
