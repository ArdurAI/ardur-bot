// @vitest-environment jsdom
import type { Bot, ComputerStatus, WorkspaceContext } from "@ardurbot/contracts";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeWorkspaceView, defaultWorkspaceLayout, openWorkspaceView } from "./layout-state";
import { WorkspacePane } from "./WorkspacePane";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
  msg: (parts: TemplateStringsArray) => parts,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    workspace: {
      describe: async () => ({
        botId: "bot",
        computerId: "computer",
        generation: 1,
        files: "live",
        observedAt: "2026-09-30T00:00:00Z",
      }),
    },
  },
}));
vi.mock("./WorkspaceTasks", () => ({ WorkspaceTasks: () => <div data-body="tasks" /> }));
vi.mock("./WorkspaceFiles", () => ({
  WorkspaceFiles: ({
    context,
    onContextChange,
  }: {
    context: WorkspaceContext;
    onContextChange?(context: WorkspaceContext): void;
  }) => (
    <>
      <textarea data-body="files" data-generation={context.generation} defaultValue="draft" />
      <button type="button" onClick={() => onContextChange?.({ ...context, generation: 2 })}>
        Recover binding
      </button>
    </>
  ),
}));
vi.mock("./WorkspaceTerminal", () => ({ WorkspaceTerminal: () => <div data-body="terminal" /> }));
const bot = { id: "bot", name: "Bot" } as Bot;
const computer = {
  computerId: "computer",
  kind: "docker",
  state: "running",
  capabilities: { graphical: false, interactiveTerminal: true },
} as ComputerStatus;
const props = {
  bot,
  computer,
  onOpenRun: vi.fn(),
  routines: <div>Routines</div>,
  screen: { computer, open: false, url: null, error: null, onOpen: vi.fn() },
  terminal: {
    working: false,
    onTakeControl: async () => {},
    onStop: async () => {},
    onStart: async () => {},
    onReleased: () => {},
  },
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("renders only opened views and preserves body identity through selection and expansion", async () => {
  const views = [{ type: "files" as const }, { type: "terminal" as const }];
  await act(async () =>
    root.render(<WorkspacePane {...props} openViews={views} tab="files" onTabChange={vi.fn()} />),
  );
  const editor = host.querySelector("textarea");
  expect(host.querySelector('[role="tablist"]')?.textContent).not.toContain("Tasks");
  await act(async () =>
    root.render(
      <WorkspacePane {...props} openViews={views} tab="terminal" expanded onTabChange={vi.fn()} />,
    ),
  );
  expect(host.querySelector("textarea")).toBe(editor);
  expect(host.querySelector('[data-body="terminal"]')).not.toBeNull();
  await act(async () =>
    root.render(<WorkspacePane {...props} openViews={views} tab="files" onTabChange={vi.fn()} />),
  );
  expect(host.querySelector("textarea")).toBe(editor);
});
it("closes only the named view, selecting its neighbour and unmounting its body", async () => {
  function Harness() {
    const [layout, update] = useState(openWorkspaceView(defaultWorkspaceLayout(), "terminal"));
    return (
      <WorkspacePane
        {...props}
        openViews={layout.open}
        tab={layout.active!}
        onTabChange={(tab) => update((current) => openWorkspaceView(current, tab as "tasks"))}
        onClose={(tab) => update((current) => closeWorkspaceView(current, tab as "terminal"))}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  expect(host.querySelector('[data-body="terminal"]')).not.toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Close Terminal"]')!.click(),
  );
  expect(host.querySelector('[data-body="terminal"]')).toBeNull();
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Routines");
});
it("never mounts a restored terminal until explicitly requested", async () => {
  const change = vi.fn();
  await act(async () =>
    root.render(
      <WorkspacePane
        {...props}
        tab="terminal"
        openViews={[{ type: "terminal" }]}
        allowTerminalStart={false}
        onTabChange={change}
      />,
    ),
  );
  expect(host.querySelector('[data-body="terminal"]')).toBeNull();
  const open = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Open terminal",
  );
  await act(async () => open!.click());
  expect(change).toHaveBeenCalledWith("terminal");
});
it("a lost capability keeps its selection and offers Retry, not a Tasks fallback", async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(
      <WorkspacePane
        {...props}
        computer={null}
        tab="terminal"
        openViews={[{ type: "terminal" }]}
        onTabChange={vi.fn()}
        onRetry={retry}
      />,
    ),
  );
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Terminal");
  expect(host.textContent).toContain("Terminal is unavailable on this computer.");
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click(),
  );
  expect(retry).toHaveBeenCalledOnce();
});

it("publishes a recovered binding to the pane owner while retaining its file view", async () => {
  await act(async () =>
    root.render(
      <WorkspacePane
        {...props}
        openViews={[{ type: "files" }]}
        tab="files"
        onTabChange={vi.fn()}
      />,
    ),
  );
  const editor = host.querySelector("textarea");
  expect(editor?.getAttribute("data-generation")).toBe("1");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Recover binding")!
      .click(),
  );
  expect(host.querySelector("textarea")).toBe(editor);
  expect(editor?.getAttribute("data-generation")).toBe("2");
});
it("forwards recovery to the supplied context owner", async () => {
  const publish = vi.fn();
  const context: WorkspaceContext = {
    botId: "bot",
    computerId: "computer",
    generation: 1,
    files: "live",
    observedAt: "2026-09-30T00:00:00Z",
  };
  await act(async () =>
    root.render(
      <WorkspacePane
        {...props}
        context={context}
        onContextChange={publish}
        openViews={[{ type: "files" }]}
        tab="files"
        onTabChange={vi.fn()}
      />,
    ),
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Recover binding")!
      .click(),
  );
  expect(publish).toHaveBeenCalledWith({ ...context, generation: 2 });
});
