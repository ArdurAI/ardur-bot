// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  config: vi.fn(async () => ({ json: '{"mcpServers":{}}', revision: "fixture" })),
  preview: vi.fn(async () => ({
    id: "preview",
    changes: [{ name: "fixture", action: "add", before: null, after: '{"TOKEN":"[redacted]"}' }],
  })),
  apply: vi.fn(async () => undefined),
}));
const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: translate }) }));
vi.mock("../../lib/rpc", () => ({
  rpc: { developer: { config: calls.config, preview: calls.preview } },
  selectedSpaceId: () => "space",
}));
vi.mock("./native", () => ({
  ensureCustomizationHost: async () => ({ applyConfig: calls.apply }),
}));
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
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  };
});

import { McpConfigEditor } from "./McpConfigEditor";

it("requires a validated diff before the native apply boundary", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div"),
    root = createRoot(element);
  const closed = vi.fn(),
    applied = vi.fn();
  try {
    await act(async () => root.render(<McpConfigEditor onClose={closed} onApplied={applied} />));
    await act(async () =>
      [...element.querySelectorAll("button")]
        .find((button) => button.textContent === "Review changes")!
        .click(),
    );
    expect(calls.preview).toHaveBeenCalledWith({ json: '{"mcpServers":{}}', revision: "fixture" });
    expect(calls.apply).not.toHaveBeenCalled();
    expect(element.textContent).toContain("[redacted]");
    await act(async () =>
      [...element.querySelectorAll("button")]
        .find((button) => button.textContent === "Apply")!
        .click(),
    );
    expect(calls.apply).toHaveBeenCalledExactlyOnceWith("space", "preview");
    expect(applied).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
