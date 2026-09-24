// @vitest-environment jsdom
import type { DesktopUpdateState } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopUpdateSection, DesktopUpdatesProvider } from "./DesktopUpdates";

const bridge = vi.hoisted(() => ({
  state: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
}));
vi.mock("../lib/desktop", () => ({ desktopBridge: () => ({ update: bridge }) }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
}));
const host = document.createElement("div");
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
it("offers an unsigned download in the prompt and settings without claiming installation", async () => {
  const state: DesktopUpdateState = {
    phase: "available",
    currentVersion: "0.1.0",
    availableVersion: "0.2.0",
    percent: null,
    checkedAt: null,
    message: null,
    downloadOnly: true,
  };
  bridge.state.mockResolvedValue(state);
  bridge.download.mockResolvedValue(state);
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <DesktopUpdatesProvider>
        <DesktopUpdateSection />
      </DesktopUpdatesProvider>,
    ),
  );
  const buttons = [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "A new version is available — download",
  );
  expect(buttons).toHaveLength(2);
  expect(host.textContent).not.toMatch(/Restart to update|Downloading|0%/);
  await act(async () => buttons[0]!.click());
  expect(bridge.download).toHaveBeenCalledOnce();
  expect(bridge.install).not.toHaveBeenCalled();
});
