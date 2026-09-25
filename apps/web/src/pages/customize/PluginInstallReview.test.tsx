// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
    i18n: { locale: "en" },
  }),
}));
vi.mock("../../lib/rpc", () => ({ rpc: {}, selectedSpaceId: () => "space" }));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogFooter: Container,
    Button: ({ variant: _, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
  };
});

import { PluginInstallReview } from "./PluginsPage";

it("shows every added component and waits for the single install action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"),
    root = createRoot(element);
  const install = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PluginInstallReview
          summary={{
            name: "fixture",
            description: "Review",
            author: null,
            version: "1.0.0",
            skills: ["skills/review/SKILL.md"],
            commands: ["commands/review.md"],
            servers: ["fixture-server"],
            instructions: ["output-styles/review.md"],
          }}
          busy={false}
          onClose={() => undefined}
          onInstall={install}
        />,
      ),
    );
    for (const text of [
      "Skills (1)",
      "Commands (1)",
      "MCP servers (1)",
      "Instructions (1)",
      "fixture-server",
    ])
      expect(element.textContent).toContain(text);
    expect(install).not.toHaveBeenCalled();
    await act(async () =>
      [...element.querySelectorAll("button")]
        .find((button) => button.textContent === "Install")!
        .click(),
    );
    expect(install).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
