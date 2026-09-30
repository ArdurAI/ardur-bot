// @vitest-environment jsdom
import type { ComputerStatus } from "@ardurbot/contracts";
import { COMPUTER_KINDS, computerRuntimeSummary } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
const api = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  status: vi.fn(),
  connections: vi.fn(async () => []),
  me: vi.fn(async () => ({ sandboxProvider: "docker" })),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { computer: api, me: api.me } }));

import { BotRuntimeSettings, RuntimeSummary } from "./runtime-summary";

const status = {
  botId: "bot",
  kind: "desktop",
  mode: "dedicated",
  state: "stopped",
} as ComputerStatus;
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it.each(Object.keys(COMPUTER_KINDS) as ComputerStatus["kind"][])(
  "renders shared execution facts for %s",
  async (kind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      const current = { ...status, kind };
      await act(async () => root.render(<RuntimeSummary status={current} />));
      const facts = computerRuntimeSummary(current)!;
      expect(container.textContent).toContain(facts.location);
      expect(container.textContent).toContain(facts.reach);
      expect(container.textContent).toContain("Only this bot");
      expect(container.textContent).toContain("Stopped");
      await act(async () => root.render(<RuntimeSummary status={current} mode="team" />));
      expect(container.textContent).toContain("Bots share files and installed tools");
      expect(container.textContent).toContain("Shared with team");
    } finally {
      await act(async () => root.unmount());
    }
  },
);
it("refuses unknown kinds rather than suggesting isolation", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(<RuntimeSummary status={{ ...status, kind: "vm" as ComputerStatus["kind"] }} />),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Choose a supported connection",
  );
  await act(async () => root.unmount());
});
it("loads the existing pin read-only and ignores a late response for another bot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolve!: (value: ComputerStatus) => void;
  api.status
    .mockImplementationOnce(
      () =>
        new Promise<ComputerStatus>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ ...status, botId: "second", kind: "ssh" });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<BotRuntimeSettings botId="first" name="First" mode="dedicated" />),
    );
    await act(async () =>
      root.render(<BotRuntimeSettings botId="second" name="Second" mode="dedicated" />),
    );
    await act(async () => resolve(status));
    expect(container.textContent).toContain("Remote computer");
    expect(container.textContent).not.toContain("Runs as you");
    expect(api.status).toHaveBeenCalledWith({ botId: "second" });
  } finally {
    await act(async () => root.unmount());
  }
});
