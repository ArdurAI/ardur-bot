// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsPageProps } from "../settings-types";
import BoardsSettings from "./BoardsSettings";

const api = vi.hoisted(() => ({
  workspaces: vi.fn(),
  configure: vi.fn(),
  start: vi.fn(),
  bots: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { board: api, bots: { list: api.bots } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});
async function render(initialized = true, allowedBotIds: string[] = []) {
  api.workspaces.mockResolvedValue({
    workspaces: [
      {
        id: "workspace",
        name: "Planning",
        kind: "folder",
        path: "/fixture/project",
        prefix: "work",
        enabled: true,
        initialized,
        isDefault: false,
        allowAllBots: false,
        allowedBotIds,
      },
    ],
    problem: null,
  });
  api.bots.mockResolvedValue([{ id: "builder", name: "Builder" }]);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () =>
    root.render(
      <BoardsSettings
        {...({ onBusyChange: vi.fn(), navigate: vi.fn() } as unknown as SettingsPageProps)}
      />,
    ),
  );
  return node;
}
const button = (node: HTMLElement, label: string) =>
  [...node.querySelectorAll("button")].find((button) => button.textContent === label)!;
it("removes unavailable bots when saving the remaining allowlist", async () => {
  const node = await render(true, ["archived", "deleted"]);
  await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { allowedBotIds: ["builder"] },
  });
});
it("initializes only after Settings confirmation and shows the files affected", async () => {
  const node = await render(false);
  expect(api.start).not.toHaveBeenCalled();
  await act(async () => button(node, "Start board").click());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain(".beads/");
  expect(api.start).not.toHaveBeenCalled();
  await act(async () => button(node, "Confirm").click());
  expect(api.start).toHaveBeenCalledWith({ workspaceId: "workspace" });
});
it("saves the default and bot allowlist and confirms reversible archive", async () => {
  const node = await render();
  await act(async () => button(node, "Make default").click());
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { isDefault: true },
  });
  await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { allowedBotIds: ["builder"] },
  });
  await act(async () => button(node, "Archive board").click());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain("Board files will be kept.");
  expect(api.configure).not.toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { enabled: false },
  });
  await act(async () => button(node, "Confirm").click());
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { enabled: false },
  });
});
