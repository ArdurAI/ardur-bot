// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
}));
vi.mock("../lib/rpc", () => ({ rpc: {} }));

import { SoftwareUpdatePanel } from "./SoftwareUpdateSection";

it("shows the continuation sentence only while applying an update", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = { check: null, error: null, done: null, onCheck: () => {}, onApply: () => {} };
  try {
    await act(async () => root.render(<SoftwareUpdatePanel {...props} busy="apply" />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Updating — your bots will continue after the update",
    );
    await act(async () => root.render(<SoftwareUpdatePanel {...props} busy={null} />));
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
