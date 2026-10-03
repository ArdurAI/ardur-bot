// @vitest-environment jsdom
import { COMPUTER_BOUNDARY_MESSAGES } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const configure = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../lib/rpc", () => ({ rpc: { computer: { configure } } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
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
    AlertDialogAction: button,
    AlertDialogCancel: button,
  };
});

import { ComputerLocationPicker } from "./computer-location-picker";
import { MoveToHost } from "./move-to-host";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  configure.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it.each(["host", "sandbox"] as const)(
  "gives both locations equal structure and preselects %s",
  async (value) => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <ComputerLocationPicker value={value} hostAvailable sandboxAvailable onChange={onChange} />,
      ),
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.className).toBe(buttons[1]!.className);
    expect(buttons.map((button) => button.childElementCount)).toEqual([1, 1]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(
      value === "host" ? ["true", "false"] : ["false", "true"],
    );
    expect(container.textContent).toContain("Runs as you; can use your files and signed-in tools");
    expect(container.textContent).toContain(
      "Separate home; can reach allowed network services and granted credentials.",
    );
    await act(async () => buttons[value === "host" ? 1 : 0]!.click());
    expect(onChange).toHaveBeenCalledWith(value === "host" ? "sandbox" : "host");
  },
);
it.each(["container", "hosted", "test", "account"] as const)(
  "uses the existing %s boundary consequence for Sandbox",
  async (sandboxBoundary) => {
    await act(async () =>
      root.render(
        <ComputerLocationPicker
          value="sandbox"
          hostAvailable
          sandboxAvailable
          sandboxBoundary={sandboxBoundary}
          onChange={vi.fn()}
        />,
      ),
    );
    const sandbox = container.querySelector('[aria-label="Sandbox"]')!;
    expect(sandbox.textContent).toContain(COMPUTER_BOUNDARY_MESSAGES[sandboxBoundary]);
    if (sandboxBoundary !== "container")
      expect(sandbox.textContent).not.toContain(COMPUTER_BOUNDARY_MESSAGES.container);
  },
);
it("keeps both unavailable options visible with their reasons", async () => {
  await act(async () =>
    root.render(
      <ComputerLocationPicker
        value="host"
        hostAvailable={false}
        sandboxAvailable
        runtimeKind="hermes"
        onChange={vi.fn()}
      />,
    ),
  );
  expect(
    [...container.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled),
  ).toBe(true);
  expect(container.textContent).toContain("Connect the host service to choose This computer.");
  expect(container.textContent).toContain(
    "Other locations are unavailable for Hermes. Choose This computer.",
  );
});
it.each([
  ["pi", { kind: "docker" }, false],
  ["hermes", { kind: "desktop" }, false],
  ["codex-app-server", { kind: "docker" }, true],
  [
    "hermes",
    { kind: "desktop", connectionId: "saved", connectionSettings: { engine: "docker" } },
    true,
  ],
] as const)(
  "shows the host repair only for a saved %s/location mismatch",
  async (runtimeKind, location, mismatch) => {
    const onChanged = vi.fn(async () => {});
    await act(async () =>
      root.render(
        <MoveToHost
          botId="bot"
          runtimeKind={runtimeKind}
          location={location}
          hostAvailable
          state="stopped"
          onChanged={onChanged}
        />,
      ),
    );
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);
    expect(Boolean(button("Move to This computer"))).toBe(mismatch);
    if (!mismatch) return;
    await act(async () => button("Move to This computer")!.click());
    expect(configure).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "This replaces the computer's files. Continue?",
    );
    await act(async () => button("Continue")!.click());
    expect(configure).toHaveBeenCalledExactlyOnceWith({
      botId: "bot",
      destination: "host",
      confirmed: true,
    });
    expect(onChanged).toHaveBeenCalledOnce();
  },
);
