// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopStorageRow, StorageBridge } from "./bridge";

const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: translate }) }));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
}));

import { StorageSettings } from "./StorageSettings";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function render(children: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => root.render(children));
  return container;
}

function fixture(rows: DesktopStorageRow[]) {
  const bridge: StorageBridge = {
    usage: vi.fn(async () => rows),
    clearCaches: vi.fn(async () => rows),
  };
  return { bridge };
}

const baseRows: DesktopStorageRow[] = [
  { id: "database", paths: ["/fixture/postgres"], bytes: 5_242_880, approximate: false },
  {
    id: "computerHomes",
    paths: ["/fixture/data/homes", "/fixture/data/desktop-computers"],
    bytes: 1_048_576,
    approximate: false,
  },
  { id: "checkpoints", paths: ["/fixture/data/home-revisions"], bytes: 0, approximate: false },
  { id: "artifacts", paths: ["/fixture/data/artifacts"], bytes: 0, approximate: false },
  { id: "boards", paths: ["/fixture/data/board"], bytes: 0, approximate: false },
  {
    id: "appCache",
    paths: ["/fixture/Partitions/persist:x", "/fixture/Partitions/persist:x/Code Cache"],
    bytes: 20_000,
    approximate: false,
  },
];

describe("StorageSettings", () => {
  it("shows a restart hint without the desktop bridge", async () => {
    const c = await render(<StorageSettings bridge={undefined} />);
    expect(c.textContent).toBe("Restart the desktop app to see storage usage.");
  });

  it("lists every row with its size and where it lives, with one Clear caches action", async () => {
    const f = fixture(baseRows);
    const c = await render(<StorageSettings bridge={f.bridge} />);
    await act(async () => undefined);
    expect(c.textContent).toContain("Database");
    expect(c.textContent).toContain("/fixture/postgres");
    expect(c.textContent).toContain("5.0 MB");
    expect(c.textContent).toContain("Computer homes");
    expect(c.textContent).toContain("/fixture/data/homes, /fixture/data/desktop-computers");
    // Sessions is hidden when the bridge omits it (no pi-sessions directory on this install).
    expect(c.textContent).not.toContain("Sessions");
    // Previous Docker data is hidden when the bridge omits it (no stack directory left).
    expect(c.textContent).not.toContain("Previous Docker data");
    const buttons = c.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Clear caches");
  });

  it("shows the sessions and previous Docker data rows only once the bridge reports them", async () => {
    const f = fixture([
      ...baseRows,
      { id: "sessions", paths: ["/fixture/data/pi-sessions"], bytes: 0, approximate: false },
      {
        id: "previousDockerData",
        paths: ["/fixture/stack"],
        bytes: 100,
        approximate: false,
        dockerUnavailable: true,
      },
    ]);
    const c = await render(<StorageSettings bridge={f.bridge} />);
    await act(async () => undefined);
    expect(c.textContent).toContain("Sessions");
    expect(c.textContent).toContain("Previous Docker data");
    expect(c.textContent).toContain("Docker not running");
  });

  it("shows at least once the size walk hits its cap", async () => {
    const f = fixture([
      { id: "artifacts", paths: ["/fixture/data/artifacts"], bytes: 1_048_576, approximate: true },
    ]);
    const c = await render(<StorageSettings bridge={f.bridge} />);
    await act(async () => undefined);
    expect(c.textContent).toContain("at least 1.0 MB");
  });

  it("clears caches and refreshes the rows from the bridge's reply", async () => {
    const cleared: DesktopStorageRow[] = [
      { id: "appCache", paths: ["/fixture/Partitions/persist:x"], bytes: 0, approximate: false },
    ];
    const bridge: StorageBridge = {
      usage: vi.fn(async () => baseRows),
      clearCaches: vi.fn(async () => cleared),
    };
    const c = await render(<StorageSettings bridge={bridge} />);
    await act(async () => undefined);
    expect(c.textContent).toContain("19.5 KB");
    await act(async () => (c.querySelector("button") as HTMLButtonElement).click());
    expect(bridge.clearCaches).toHaveBeenCalledOnce();
    expect(c.textContent).toContain("0 B");
    expect(c.textContent).not.toContain("Database");
  });

  it("shows an error and stops rendering rows when usage cannot be read", async () => {
    const bridge: StorageBridge = {
      usage: vi.fn(async () => {
        throw new Error("boom");
      }),
      clearCaches: vi.fn(async () => baseRows),
    };
    const c = await render(<StorageSettings bridge={bridge} />);
    await act(async () => undefined);
    expect(c.textContent).toBe("Could not read storage usage; try again.");
  });
});
