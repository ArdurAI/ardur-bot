// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../lib/rpc", () => ({ rpc: {} }));
vi.mock("../../components/integrations/catalog/IntegrationManage", () => ({
  IntegrationManage: () => null,
}));

import { IntegrationTable } from "./IntegrationTable";

it("renders types, badges and status and invokes Reconnect for only the selected row", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const reconnect = vi.fn();
  const expired = {
    id: "expired",
    name: "Expired fixture",
    type: "web" as const,
    badges: ["custom" as const],
    status: "reconnect" as const,
    available: true,
  };
  try {
    await act(async () =>
      root.render(
        <IntegrationTable
          onConnect={reconnect}
          rows={[
            expired,
            {
              id: "local",
              name: "Local fixture",
              type: "desktop",
              badges: ["local-dev"],
              status: "connected",
              available: true,
            },
            {
              id: "included",
              name: "Included fixture",
              type: "web",
              badges: ["included"],
              status: "disconnected",
              available: false,
            },
          ]}
        />,
      ),
    );
    for (const text of [
      "Integration",
      "Type",
      "Status",
      "Web",
      "Desktop",
      "Custom",
      "Included",
      "Local dev",
      "Connected",
      "Disconnected",
    ])
      expect(container.textContent).toContain(text);
    expect(container.querySelector('[aria-label="Needs reconnection"]')).not.toBeNull();
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reconnect",
    )!;
    await act(async () => button.click());
    expect(reconnect).toHaveBeenCalledWith(expired);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Connect")
        ?.disabled,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
