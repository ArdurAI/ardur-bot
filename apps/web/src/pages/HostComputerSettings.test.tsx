// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ status: vi.fn(), disconnect: vi.fn(), clear: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { host: fake } }));
const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: translate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
}));

import { HostComputerSettings } from "./HostComputerSettings";

const containers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of containers.splice(0)) await cleanup();
  delete window.ardurbotDesktop;
  vi.unstubAllGlobals();
});
async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  containers.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(<HostComputerSettings />));
  return container;
}
it.each([
  [false, "Not set up"],
  [true, "Not running — open the desktop app"],
])("shows the minimal disconnected copy (%s)", async (configured, copy) => {
  fake.status.mockResolvedValue({ configured, connected: false, health: null, roots: [] });
  const container = await render();
  expect(container.textContent).toContain(`Host service: ${copy}`);
  expect(container.textContent).toContain("This computer");
});
it("shows versions and registered folders, and revokes before clearing desktop storage", async () => {
  fake.status.mockResolvedValue({
    roots: ["/fixture/projects"],
    configured: true,
    connected: true,
    health: {
      roots: ["/fixture/projects"],
      claude: { version: "2.1.259" },
      codex: { version: "0.156.1" },
    },
  });
  window.ardurbotDesktop = {
    platform: "darwin",
    host: {
      state: async () => ({ configured: true, roots: ["/fixture/projects"] }),
      setup: vi.fn(),
      addRoot: vi.fn(),
      removeRoot: vi.fn(),
      clear: fake.clear,
    },
  } as unknown as NonNullable<Window["ardurbotDesktop"]>;
  const container = await render();
  expect(container.textContent).toContain("This Mac");
  expect(container.textContent).toContain(
    "Host service: Connected · claude 2.1.259 · codex 0.156.1",
  );
  expect(container.textContent).toContain("/fixture/projects");
  const disconnect = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Disconnect this computer",
  )!;
  await act(async () => disconnect.click());
  expect(fake.disconnect).toHaveBeenCalledOnce();
  expect(fake.clear).toHaveBeenCalledOnce();
  expect(fake.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
    fake.clear.mock.invocationCallOrder[0]!,
  );
});
