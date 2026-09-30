// @vitest-environment jsdom
import type { Bot, ComputerStatus } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePane } from "./WorkspacePane";

const describeCall = vi.fn();
vi.mock("../../lib/rpc", () => ({
  rpc: {
    workspace: {
      describe: (...args: unknown[]) => describeCall(...args),
    },
  },
}));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./WorkspaceTasks", () => ({
  WorkspaceTasks: ({ visible }: { visible: boolean }) => (
    <div data-testid="workspace-tasks" data-visible={visible}>
      Tasks content
    </div>
  ),
}));

vi.mock("./WorkspaceFiles", () => ({
  WorkspaceFiles: () => <div data-testid="workspace-files">Files content</div>,
}));

vi.mock("./WorkspaceScreen", () => ({
  WorkspaceScreen: () => <div data-testid="workspace-screen">Screen content</div>,
}));

vi.mock("./WorkspaceTerminal", () => ({
  WorkspaceTerminal: ({ visible }: { visible: boolean }) => (
    <div data-testid="workspace-terminal" data-visible={visible}>
      Terminal content
    </div>
  ),
}));

const bot: Bot = {
  id: "bot-1",
  name: "Helper Bot",
  spaceId: "space-1",
  title: "",
  description: "",
  instructions: "",
  color: "slate",
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-1",
  preview: "",
  status: "idle",
  computerMode: "team",
  updatedAt: "2026-09-28",
  createdAt: "2026-09-28",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
  runtimeKind: "pi",
};

const graphicalComputer: ComputerStatus = {
  botId: "bot-1",
  computerId: "computer-1",
  mode: "team",
  kind: "kubernetes",
  state: "running",
  capabilities: { graphical: true, interactiveTerminal: false },
  controlHolder: "none",
  controlBotId: null,
  takeoverRequested: false,
  screenAvailable: true,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: "saved",
  busyBotName: null,
  canUpdate: false,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  describeCall.mockResolvedValue({
    botId: "bot-1",
    computerId: "computer-1",
    generation: 1,
    files: "unavailable",
    observedAt: "2026-09-28T00:00:00.000Z",
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("WorkspacePane tab selection and content rendering", () => {
  it("defaults to Tasks tab on graphical computers when tab is empty", async () => {
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={graphicalComputer}
          tab=""
          terminal={null}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: graphicalComputer,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Tasks");
    const tasksContent = container.querySelector('[data-testid="workspace-tasks"]');
    expect(tasksContent).not.toBeNull();
    expect(tasksContent?.getAttribute("data-visible")).toBe("true");
  });

  it("retains Files with a reason when the computer loses files", async () => {
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={graphicalComputer}
          tab="files"
          terminal={null}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: graphicalComputer,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Files");
    expect(container.textContent).toContain("Files are unavailable on this computer.");
    expect(container.querySelector('[data-testid="workspace-files"]')).toBeNull();
  });

  it("activates Screen tab only when explicitly chosen on graphical computers", async () => {
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={graphicalComputer}
          tab="screen"
          terminal={null}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: graphicalComputer,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Screen");
  });

  it("retains Screen with a reason on non-graphical computers", async () => {
    const nonGraphical = {
      ...graphicalComputer,
      capabilities: { graphical: false, interactiveTerminal: false },
    };
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={nonGraphical}
          tab="screen"
          terminal={null}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: nonGraphical,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Screen");
    expect(container.textContent).toContain("Screen is unavailable on this computer.");
    expect(container.querySelector('[data-testid="workspace-screen"]')).toBeNull();
    expect(container.querySelector('[role="tablist"]')?.textContent).toContain("Computer");
  });

  it("activates Computer tab when Computer is chosen on non-graphical computers", async () => {
    const nonGraphical = {
      ...graphicalComputer,
      capabilities: { graphical: false, interactiveTerminal: false },
    };
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={nonGraphical}
          tab="computer"
          terminal={null}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: nonGraphical,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Computer");
  });

  it("activates Files tab when files are available and tab is files", async () => {
    describeCall.mockResolvedValue({
      botId: "bot-1",
      computerId: "computer-1",
      generation: 1,
      files: "live",
      observedAt: "2026-09-28T00:00:00.000Z",
    });
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={graphicalComputer}
          tab="files"
          terminal={null}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: graphicalComputer,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Files");
  });
});

describe("WorkspacePane terminal tab", () => {
  const terminalComputer: ComputerStatus = {
    ...graphicalComputer,
    kind: "docker",
    capabilities: { graphical: true, interactiveTerminal: true },
  };
  const terminal = {
    working: false,
    onTakeControl: async () => {},
    onStop: async () => {},
    onStart: async () => {},
    onReleased: () => {},
  };

  it("shows and activates the Terminal tab when the computer supports a terminal", async () => {
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={terminalComputer}
          tab="terminal"
          terminal={terminal}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: terminalComputer,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Terminal");
    const content = container.querySelector('[data-testid="workspace-terminal"]');
    expect(content).not.toBeNull();
    expect(content?.getAttribute("data-visible")).toBe("true");
  });

  it("retains Terminal with a reason without starting a session when support is lost", async () => {
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={graphicalComputer}
          tab="terminal"
          terminal={terminal}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: graphicalComputer,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Terminal");
    expect(container.textContent).toContain("Terminal is unavailable on this computer.");
    expect(container.querySelector('[data-testid="workspace-terminal"]')).toBeNull();
  });

  it("keeps a remembered Terminal unavailable when no terminal surface is provided", async () => {
    await act(async () =>
      root.render(
        <WorkspacePane
          bot={bot}
          computer={terminalComputer}
          tab="terminal"
          terminal={null}
          onTabChange={vi.fn()}
          onOpenRun={vi.fn()}
          routines={<div>Routines content</div>}
          screen={{
            computer: terminalComputer,
            open: false,
            url: null,
            error: null,
            onOpen: vi.fn(),
          }}
        />,
      ),
    );
    const activeTab = container.querySelector('[role="tab"][data-active]');
    expect(activeTab?.textContent).toBe("Terminal");
    expect(container.textContent).toContain("Terminal is unavailable on this computer.");
  });
});
