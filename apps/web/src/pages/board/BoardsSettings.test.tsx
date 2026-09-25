// @vitest-environment jsdom

import { ORPCError } from "@orpc/client";
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
function serverError(message: string) {
  return new ORPCError("BAD_REQUEST", { message });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function render(
  initialized = true,
  allowedBotIds: string[] = [],
  options: { allowAllBots?: boolean; second?: boolean } = {},
) {
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
        allowAllBots: options.allowAllBots ?? false,
        allowedBotIds,
      },
      ...(options.second
        ? [
            {
              id: "other",
              name: "Archive",
              kind: "folder" as const,
              path: "/fixture/other",
              prefix: "other",
              enabled: true,
              initialized: true,
              isDefault: false,
              allowAllBots: true,
              allowedBotIds: [] as string[],
            },
          ]
        : []),
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
it("keeps a failed start open and shows the server sentence beside the action", async () => {
  api.start.mockRejectedValueOnce(serverError("This folder already has a board."));
  const node = await render(false);
  await act(async () => button(node, "Start board").click());
  await act(async () => button(node, "Confirm").click());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain(
    "This folder already has a board.",
  );
  expect(node.textContent).not.toContain("Could not load");
});
it("shows a failed save sentence beside the name control", async () => {
  api.configure.mockRejectedValueOnce(serverError("This name could not be saved."));
  const node = await render();
  await act(async () => node.querySelector("form")!.requestSubmit());
  expect(node.querySelector("form")?.parentElement?.textContent).toContain(
    "This name could not be saved.",
  );
  expect(node.textContent).not.toContain("Could not load");
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
it("shows a refresh failure when starting succeeds and reloading does not", async () => {
  const node = await render(false);
  api.start.mockResolvedValueOnce({ ok: true });
  api.workspaces.mockRejectedValueOnce(serverError("Could not refresh this board."));
  await act(async () => button(node, "Start board").click());
  await act(async () => button(node, "Confirm").click());
  expect(node.querySelector('[role="dialog"]')).toBeNull();
  expect(node.textContent).toContain("Not initialized");
  expect(node.querySelector('[data-settings-row="Beads"]')?.textContent).toContain(
    "Could not refresh this board.",
  );
});
it("shows a failed change to selected bots while every bot stays allowed", async () => {
  api.configure.mockRejectedValueOnce(serverError("Could not save the bot list."));
  const node = await render(true, [], { allowAllBots: true });
  const select = node.querySelector<HTMLSelectElement>('select[aria-label="Allowed bots"]')!;
  expect(select.value).toBe("all");
  await choose(select, "selected");
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { allowAllBots: false },
  });
  expect(select.value).toBe("all");
  expect(node.querySelector('[data-settings-row="Allowed bots"]')?.textContent).toContain(
    "Could not save the bot list.",
  );
});
it("clears a rename failure when the selected board changes", async () => {
  api.configure.mockRejectedValueOnce(serverError("This name could not be saved."));
  const node = await render(true, [], { second: true });
  await act(async () => node.querySelector("form")!.requestSubmit());
  expect(node.textContent).toContain("This name could not be saved.");
  await choose(node.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!, "other");
  expect(node.textContent).not.toContain("This name could not be saved.");
  expect(node.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe("Archive");
});
it("keeps the board picker locked until a pending action settles", async () => {
  let reject: (error: unknown) => void = () => {};
  api.configure.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const node = await render(true, [], { second: true });
  await act(async () => node.querySelector("form")!.requestSubmit());
  const picker = node.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!;
  expect(picker.disabled).toBe(true);
  await act(async () => {
    reject(serverError("This name could not be saved."));
  });
  expect(picker.disabled).toBe(false);
  expect(node.querySelector("form")?.parentElement?.textContent).toContain(
    "This name could not be saved.",
  );
});
it("shows a server sentence and hides a browser fetch failure", async () => {
  api.configure.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const node = await render();
  await act(async () => node.querySelector("form")!.requestSubmit());
  expect(node.querySelector("form")?.parentElement?.textContent).toContain(
    "Could not complete this action.",
  );
  expect(node.textContent).not.toContain("Failed to fetch");
  api.configure.mockRejectedValueOnce(serverError("This name could not be saved."));
  await act(async () => node.querySelector("form")!.requestSubmit());
  expect(node.querySelector("form")?.parentElement?.textContent).toContain(
    "This name could not be saved.",
  );
});
