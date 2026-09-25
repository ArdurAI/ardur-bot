// @vitest-environment jsdom
import type { MessageDescriptor } from "@lingui/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WindowChrome } from "./WindowChrome";

const platform = vi.hoisted(() => ({ value: "darwin" }));
vi.mock("../lib/desktop", () => ({
  desktopBridge: () => ({}),
  windowChromeKind: () => platform.value,
}));
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: (value: MessageDescriptor) => value.message ?? value.id } }),
}));
afterEach(() => vi.unstubAllGlobals());
it.each(["darwin", "win32", "linux", "browser"])(
  "renders navigation on %s, reserving only the macOS traffic light space",
  async (os) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    platform.value = os;
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () =>
      root.render(
        <MemoryRouter>
          <WindowChrome navigation />
        </MemoryRouter>,
      ),
    );
    expect(Array.from(node.querySelectorAll("nav a"), (link) => link.textContent)).toEqual([
      "Dashboard",
      "Bots",
      "Board",
      "IDE",
    ]);
    expect(Boolean(node.querySelector('[aria-hidden="true"]'))).toBe(os === "darwin");
    expect(node.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  },
);

it("registers all four destinations before a direct IDE load and navigates with shortcuts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  function Location() {
    return <output>{useLocation().pathname}</output>;
  }
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app/ide"]}>
        <WindowChrome navigation />
        <Location />
      </MemoryRouter>,
    ),
  );
  expect(document.title).toBe("IDE — Ardur Bot");
  expect(node.querySelector('[aria-current="page"]')?.textContent).toBe("IDE");
  for (const [key, label, path] of [
    ["1", "Dashboard", "/app"],
    ["2", "Bots", "/app/bots"],
    ["3", "Board", "/app/board"],
    ["4", "IDE", "/app/ide"],
  ]) {
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          ctrlKey: true,
          cancelable: true,
        }),
      ),
    );
    expect(node.querySelector("output")?.textContent).toBe(path);
    expect(document.title).toBe(`${label} — Ardur Bot`);
  }
  await act(async () => root.unmount());
});
