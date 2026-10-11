// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replaceAll("#", String(value)),
}));
vi.mock("../components/DesktopUpdates", () => ({ DesktopUpdateSection: () => null }));
vi.mock("../components/SoftwareUpdateSection", () => ({ SoftwareUpdateSection: () => null }));
vi.mock("./ComputerProfilesSettings", () => ({ ComputerProfilesSettings: () => null }));
vi.mock("./fleet/FleetSettings", () => ({ FleetSettings: () => null }));
vi.mock("./HostComputerSettings", () => ({ HostComputerSettings: () => null }));

import { UsageSettingsPanel } from "./AccountSettingsOverlay";

it("shows lifetime runs and records separately without relabelling older server counts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <UsageSettingsPanel
          usage={{ runs: 9, records: 9, runCount: 2, inputTokens: 100, outputTokens: 5 }}
        />,
      ),
    );
    expect(node.textContent).toContain("2 runs · 9 usage records · 105 tokens");
    await act(async () =>
      root.render(<UsageSettingsPanel usage={{ runs: 9, inputTokens: 100, outputTokens: 5 }} />),
    );
    expect(node.textContent).toContain("9 usage records · 105 tokens");
    expect(node.textContent).not.toContain("9 runs");
    await act(async () =>
      root.render(
        <UsageSettingsPanel
          usage={{ runs: 1, records: 1, runCount: 1, inputTokens: 1, outputTokens: 0 }}
        />,
      ),
    );
    expect(node.textContent).toContain("1 run · 1 usage record · 1 token");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
