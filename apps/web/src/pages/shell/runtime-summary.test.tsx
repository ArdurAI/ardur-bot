// @vitest-environment jsdom
import type { ComputerStatus, ComputerUpdate } from "@ardurbot/contracts";
import { COMPUTER_KINDS, COMPUTER_STATES, computerRuntimeSummary } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
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
  updates: vi.fn<() => Promise<ComputerUpdate[]>>(async () => []),
  releaseInterrupted: vi.fn(async (_id: string) => {}),
  host: vi.fn(async () => ({ connected: true })),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { computer: api, me: api.me, host: { status: api.host } },
}));
vi.mock("../../lib/computer-updates", () => ({
  computerUpdates: { releaseInterrupted: api.releaseInterrupted },
}));
vi.mock("@ardurbot/ui-web", () => {
  const box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const button = ({
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { variant?: string }) => <button {...props} />;
  return {
    Button: button,
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="alertdialog">{children}</div> : null,
    AlertDialogContent: box,
    AlertDialogHeader: box,
    AlertDialogTitle: box,
    AlertDialogDescription: box,
    AlertDialogFooter: box,
    AlertDialogCancel: button,
    AlertDialogAction: button,
  };
});

import { BotRuntimeSettings, RuntimeSummary } from "./runtime-summary";

const status = {
  botId: "bot",
  kind: "desktop",
  mode: "dedicated",
  state: "stopped",
} as ComputerStatus;
afterEach(() => {
  vi.clearAllMocks();
  api.updates.mockResolvedValue([]);
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
it.each(Object.entries(COMPUTER_STATES))(
  "renders the honest phrase for state %s",
  async (state, label) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <RuntimeSummary status={{ ...status, state: state as ComputerStatus["state"] }} />,
        ),
      );
      expect(container.textContent).toContain(label);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it.each([true, false])(
  "shows an interrupted update without the banner (release allowed: %s)",
  async (canReleaseReservation) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const current = { ...status, computerId: "computer", state: "suspending" as const };
    const update: ComputerUpdate = {
      id: "interrupted",
      botId: "other-bot",
      computerId: "computer",
      name: "Builder",
      mode: "team",
      status: "interrupted",
      stage: "saving",
      action: "update",
      canReleaseReservation,
    };
    api.status.mockResolvedValue(current);
    api.updates.mockResolvedValue([update]);
    const container = document.createElement("div");
    const root = createRoot(container);
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);
    try {
      await act(async () =>
        root.render(<BotRuntimeSettings botId="bot" name="Builder" mode="dedicated" />),
      );
      expect(container.textContent).toContain("Paused for an update");
      expect(container.textContent).not.toContain("Starting");
      expect(container.textContent).toContain("The last update was interrupted.");
      expect(Boolean(button("Release computer"))).toBe(canReleaseReservation);
      if (!canReleaseReservation) return;
      await act(async () => button("Release computer")!.click());
      expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
        "Release interrupted computer?",
      );
      expect(container.textContent).toContain(
        "Make sure nothing is still running on this computer.",
      );
      expect(api.releaseInterrupted).not.toHaveBeenCalled();
      api.updates.mockResolvedValue([]);
      api.status.mockResolvedValue({ ...current, state: "stopped" });
      await act(async () => button("Nothing is still running")!.click());
      expect(api.releaseInterrupted).toHaveBeenCalledExactlyOnceWith("interrupted");
      expect(container.textContent).toContain("Stopped");
      expect(container.textContent).not.toContain("The last update was interrupted.");
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
