// @vitest-environment jsdom
import type { MessageDescriptor } from "@lingui/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopNav } from "./TopNav";
import { currentTopNavId, registerTopNavItem, topNavShortcut, useTopNavItems } from "./top-nav";

vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: (value: MessageDescriptor) => value.message ?? value.id } }),
}));
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  for (const fn of cleanup.splice(0)) fn();
  vi.unstubAllGlobals();
});
function View() {
  const items = useTopNavItems();
  const location = useLocation();
  return (
    <>
      <TopNav />
      <output>{location.pathname}</output>
      <span data-order>{items.map((item) => item.id).join(",")}</span>
    </>
  );
}
it("orders available registrations, omits unavailable routes, and updates after registration", async () => {
  cleanup.push(
    registerTopNavItem({
      id: "ide",
      label: { id: "IDE" },
      to: "/app/ide",
      order: 40,
      available: false,
    }),
  );
  cleanup.push(
    registerTopNavItem({
      id: "board",
      label: { id: "Board" },
      to: "/app/board",
      order: 30,
      available: () => true,
    }),
  );
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app"]}>
        <View />
      </MemoryRouter>,
    ),
  );
  expect(node.querySelector("[data-order]")?.textContent).toBe("dashboard,bots,board");
  expect(node.textContent).not.toContain("IDE");
  expect(document.title).toBe("Dashboard — Ardur Bot");
  await act(async () => {
    cleanup.push(
      registerTopNavItem({
        id: "ide",
        label: { id: "IDE" },
        to: "/app/ide",
        order: 40,
        available: true,
      }),
    );
  });
  expect(node.querySelector("[data-order]")?.textContent).toBe("dashboard,bots,board,ide");
});
it("routes shortcuts in available registration order and reflects bot deep links in the title", async () => {
  cleanup.push(
    registerTopNavItem({
      id: "board",
      label: { id: "Board" },
      to: "/app/board",
      order: 30,
      available: true,
    }),
  );
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app/g/room"]}>
        <View />
      </MemoryRouter>,
    ),
  );
  expect(document.title).toBe("Bots — Ardur Bot");
  for (const [key, title, path] of [
    ["1", "Dashboard", "/app"],
    ["2", "Bots", "/app/bots"],
    ["3", "Board", "/app/board"],
  ]) {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: true, cancelable: true });
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(document.title).toBe(`${title} — Ardur Bot`);
    expect(node.querySelector("output")?.textContent).toBe(path);
  }
  const unhandled = new KeyboardEvent("keydown", { key: "4", metaKey: true, cancelable: true });
  window.dispatchEvent(unhandled);
  expect(unhandled.defaultPrevented).toBe(false);
});
it("ignores modified and repeated shortcuts and preserves legacy bot selection", () => {
  const item = { id: "bots", label: { id: "Bots" }, to: "/app/bots", order: 20, available: true };
  expect(currentTopNavId("/app/bot-id", [item])).toBe("bots");
  for (const options of [
    {},
    { ctrlKey: true, altKey: true },
    { metaKey: true, shiftKey: true },
    { metaKey: true, repeat: true },
  ])
    expect(
      topNavShortcut(new KeyboardEvent("keydown", { key: "1", ...options }), [item]),
    ).toBeUndefined();
  expect(
    topNavShortcut(new KeyboardEvent("keydown", { code: "Digit1", metaKey: true }), [item]),
  ).toBe(item);
});

it("registers IDE as the third destination without a Board tab", async () => {
  await import("./ide-nav");
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app"]}>
        <View />
      </MemoryRouter>,
    ),
  );
  expect(node.querySelector("[data-order]")?.textContent).toBe("dashboard,bots,ide");
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", ctrlKey: true })),
  );
  expect(node.querySelector("output")?.textContent).toBe("/app/ide");
  expect(document.title).toBe("IDE — Ardur Bot");
});
