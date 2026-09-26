// @vitest-environment jsdom
import type { Me } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ me: vi.fn(), update: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { me: fake.me, deployment: { update: fake.update } } }));
const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: translate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
    Dialog: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
    DialogContent: Box,
    DialogDescription: Box,
    DialogHeader: Box,
    DialogTitle: Box,
  };
});

import { HostComputerPrompt } from "./HostComputerPrompt";

const WARNING =
  "Local access lets bots run commands without asking. Avoid it on shared or public servers.";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete window.ardurbotDesktop;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render(me: Partial<Me>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.ardurbotDesktop = { platform: "darwin" } as NonNullable<Window["ardurbotDesktop"]>;
  fake.me.mockResolvedValue(me);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  // Both the bootstrap payload and a later `me` read must agree.
  await act(async () => root.render(<HostComputerPrompt initialMe={me as Me} />));
  const bootstrap = container.textContent ?? "";
  await act(async () => root.render(<HostComputerPrompt key="fetched" />));
  return { bootstrap, fetched: container.textContent ?? "" };
}

// What the API answers in each deployment shape.
it.each([
  [
    "the desktop app's local mode",
    { sandboxProvider: "desktop", canChooseHostComputer: false, computerHost: "this-mac" },
  ],
  [
    "the desktop app's own Compose stack",
    { sandboxProvider: "docker", canChooseHostComputer: false, computerHost: "this-mac" },
  ],
  [
    "the desktop app's own Compose stack after choosing Docker",
    { sandboxProvider: "docker", canChooseHostComputer: false, computerHost: "docker" },
  ],
] as const)("never asks where bots run in %s", async (_shape, me) => {
  const { bootstrap, fetched } = await render(me);
  expect(bootstrap).toBe("");
  expect(fetched).toBe("");
  expect(document.body.textContent).not.toContain(WARNING);
});

it("still asks a server's owner once, with the warning, while Docker is the default", async () => {
  const { bootstrap, fetched } = await render({
    sandboxProvider: "docker",
    canChooseHostComputer: true,
    computerHost: null,
  });
  for (const text of [bootstrap, fetched]) {
    expect(text).toContain("Where should bots run?");
    expect(text).toContain(WARNING);
  }
});
