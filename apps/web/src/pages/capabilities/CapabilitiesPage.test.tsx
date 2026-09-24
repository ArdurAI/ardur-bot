// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = ({
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { variant?: string }) => <button {...props} />;
  return {
    Button,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: Omit<ComponentProps<"button">, "onChange"> & {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    }) => (
      <button
        {...props}
        role="switch"
        aria-checked={checked}
        onClick={() => onCheckedChange(!checked)}
      />
    ),
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
  };
});

import { CapabilitiesPage } from "./CapabilitiesPage";

function props(): ComponentProps<typeof CapabilitiesPage> {
  return {
    settings: { toolAccessMode: "when-needed", connectorSearch: false, inlineVisualizations: true },
    canConfigure: true,
    computers: [
      {
        id: "computer",
        name: "Test computer",
        kind: "docker",
        networkEgress: true,
        supported: true,
        pending: false,
      },
    ],
    unsupportedRuntimes: [],
    onChange: vi.fn().mockResolvedValue(undefined),
    onNetworkChange: vi.fn().mockResolvedValue(undefined),
    onOpenComputers: vi.fn(),
    onOpenCustomize: vi.fn(),
  };
}
async function mounted(element: ReactNode, run: (container: HTMLDivElement) => Promise<void>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(element));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
function button(container: HTMLElement, label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("capability settings controls", () => {
  it("requires confirmation before requesting a computer replacement", async () => {
    const input = props();
    await mounted(<CapabilitiesPage {...input} />, async (container) => {
      const toggle = button(container, "Allow network egress for Test computer");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await act(async () => toggle.click());
      expect(input.onNetworkChange).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
        "This replaces the computer's files. Continue?",
      );
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await act(async () => button(container, "Continue").click());
      expect(input.onNetworkChange).toHaveBeenCalledExactlyOnceWith("computer", false, true);
    });
  });

  it("renders current space settings read-only for non-owners", async () => {
    const input = { ...props(), canConfigure: false };
    await mounted(<CapabilitiesPage {...input} />, async (container) => {
      expect(container.querySelector("select")?.disabled).toBe(true);
      for (const toggle of container.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
        expect(toggle.disabled).toBe(true);
        await act(async () => toggle.click());
      }
      expect(input.onChange).not.toHaveBeenCalled();
      expect(input.onNetworkChange).not.toHaveBeenCalled();
      await act(async () => button(container, "Computers").click());
      expect(input.onOpenComputers).toHaveBeenCalledOnce();
    });
  });

  it("discloses runtime and network limitations and omits unsupported visual rows", async () => {
    const input = props();
    input.unsupportedRuntimes = ["Fixture runtime"];
    input.computers[0] = { ...input.computers[0]!, kind: "kubernetes", supported: false };
    await mounted(<CapabilitiesPage {...input} />, async (container) => {
      expect(container.textContent).toContain(
        "Fixture runtime loads all connected tools because deferred loading is unavailable.",
      );
      expect(container.textContent).toContain("Unsupported: no verified NetworkPolicy controller.");
      expect(button(container, "Allow network egress for Test computer").disabled).toBe(true);
      expect(container.textContent).not.toContain("AI-powered artifacts");
      expect(container.textContent).not.toContain("Switch models when a message is flagged");
      expect(container.textContent).not.toContain("Generate code, documents, and designs");
      expect(button(container, "Connector search").getAttribute("aria-checked")).toBe("false");
    });
  });
});
