// @vitest-environment jsdom

import type { Me } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  update: vi.fn(async () => ({})),
  me: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { deployment: { update: api.update }, me: api.me } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = (props: ComponentProps<"button">) => <button {...props} />;
  return {
    Button,
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Container,
    DialogDescription: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});
const bridge = vi.hoisted(() => ({ value: { platform: "darwin" } as { platform: string } }));
vi.mock("../lib/desktop", () => ({ desktopBridge: () => bridge.value }));

import { HostComputerPrompt } from "./HostComputerPrompt";

const me = {
  canChooseHostComputer: true,
  computerHost: null,
} as unknown as Me;

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

async function renderPrompt() {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<HostComputerPrompt initialMe={me} />));
  return { element, root };
}

it("shows the runs-as-you warning beside the This Mac choice on macOS", async () => {
  bridge.value = { platform: "darwin" };
  const { element, root } = await renderPrompt();
  expect(element.textContent).toContain("Where should bots run?");
  expect(element.textContent).toContain(
    "macOS will not ask for extra permission if you let bots run on this Mac. They run as you.",
  );
  await act(async () => root.unmount());
});

it("shows the generic warning on other platforms", async () => {
  bridge.value = { platform: "linux" };
  const { element, root } = await renderPrompt();
  expect(element.textContent).toContain(
    "Your OS will not ask for extra permission if you let bots run on this computer. They run as you.",
  );
  expect(element.textContent).not.toContain("macOS will not ask");
  await act(async () => root.unmount());
});

it("stays closed when the choice was already made", async () => {
  const { element, root } = await (async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    await act(async () =>
      root.render(<HostComputerPrompt initialMe={{ ...me, computerHost: "docker" }} />),
    );
    return { element, root };
  })();
  expect(element.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.unmount());
});
