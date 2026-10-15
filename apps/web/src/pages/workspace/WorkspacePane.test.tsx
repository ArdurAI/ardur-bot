// @vitest-environment jsdom
import type { Bot, ComputerStatus, WorkspaceContext } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, useLayoutEffect } from "react";
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
  msg: (parts: TemplateStringsArray) => parts,
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
  it.each([
    { connectionId: "saved-docker", files: "live" as const, selected: "Files" },
    { connectionId: "saved-podman", files: "saved" as const, selected: "Files" },
    { connectionId: null, files: "live" as const, selected: "Files" },
    { connectionId: null, files: "saved" as const, selected: "Files" },
    { connectionId: null, files: "unavailable" as const, selected: "Files" },
  ])(
    "uses supplied API file policy for a desktop row on $connectionId",
    async ({ connectionId, files, selected }) => {
      const computer: ComputerStatus = { ...graphicalComputer, kind: "desktop", connectionId };
      await act(async () =>
        root.render(
          <WorkspacePane
            bot={bot}
            computer={computer}
            context={{
              botId: bot.id,
              computerId: "computer-1",
              generation: 1,
              files,
              runsOnHost: connectionId === null,
              observedAt: "2026-09-28T00:00:00.000Z",
            }}
            tab="files"
            terminal={null}
            onTabChange={vi.fn()}
            onOpenRun={vi.fn()}
            routines={<div>Routines content</div>}
            screen={{ computer, open: false, url: null, error: null, onOpen: vi.fn() }}
          />,
        ),
      );
      expect(container.querySelector('[role="tab"][data-active]')?.textContent).toBe(selected);
      if (files === "unavailable") {
        expect(container.querySelector('[data-testid="workspace-files"]')).toBeNull();
        expect(container.textContent).toContain("Files are unavailable on this computer.");
      } else {
        expect(container.querySelector('[data-testid="workspace-files"]')).not.toBeNull();
      }
      expect(describeCall).not.toHaveBeenCalled();
    },
  );

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
    expect(activeTab?.textContent).toBe("Computer screen");
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

describe("WorkspacePane Files availability loading", () => {
  const props = {
    bot,
    computer: graphicalComputer,
    tab: "files",
    openViews: [{ type: "files" as const }],
    terminal: null,
    onTabChange: vi.fn(),
    onOpenRun: vi.fn(),
    routines: null,
    screen: {
      computer: graphicalComputer,
      open: false,
      url: null,
      error: null,
      onOpen: vi.fn(),
    },
  };
  const context: WorkspaceContext = {
    botId: bot.id,
    computerId: graphicalComputer.computerId ?? null,
    generation: 1,
    files: "live",
    observedAt: "2026-09-28T00:00:00.000Z",
  };
  function deferred() {
    let resolve!: (value: WorkspaceContext) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<WorkspaceContext>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  function expectLoading() {
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    expect(container.textContent).not.toContain("Files are unavailable on this computer.");
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "Retry"),
    ).toBe(false);
    expect(container.querySelector('[data-testid="workspace-files"]')).toBeNull();
  }

  it("keeps supplied discovery loading and delegates Retry without a second policy request", async () => {
    const onRetry = vi.fn();
    await act(async () =>
      root.render(<WorkspacePane {...props} context={null} contextLoading onRetry={onRetry} />),
    );
    expectLoading();
    await act(async () =>
      root.render(<WorkspacePane {...props} context={null} onRetry={onRetry} />),
    );
    expect(container.textContent).toContain("Files are unavailable on this computer.");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<WorkspacePane {...props} context={null} contextLoading onRetry={onRetry} />),
    );
    expectLoading();
    await act(async () =>
      root.render(<WorkspacePane {...props} context={context} onRetry={onRetry} />),
    );
    expect(container.querySelector('[data-testid="workspace-files"]')).not.toBeNull();
    expect(describeCall).not.toHaveBeenCalled();
  });

  it.each(["live", "unavailable", "failed"] as const)(
    "shows loading, not a reason or Retry, until describe settles as %s",
    async (outcome) => {
      const request = deferred();
      describeCall.mockReturnValueOnce(request.promise);
      await act(async () => root.render(<WorkspacePane {...props} />));
      expectLoading();
      await act(async () => {
        if (outcome === "failed") request.reject(new Error("Describe failed"));
        else request.resolve({ ...context, files: outcome });
      });
      expect(container.textContent).not.toContain("Loading…");
      if (outcome === "live") {
        expect(container.querySelector('[data-testid="workspace-files"]')).not.toBeNull();
        expect(container.textContent).not.toContain("Files are unavailable on this computer.");
      } else {
        expect(container.textContent).toContain("Files are unavailable on this computer.");
        expect(
          [...container.querySelectorAll("button")].some(
            (button) => button.textContent === "Retry",
          ),
        ).toBe(true);
      }
    },
  );

  it("returns to loading during Retry and applies only the new describe result", async () => {
    await act(async () => root.render(<WorkspacePane {...props} />));
    expect(container.textContent).toContain("Files are unavailable on this computer.");
    const request = deferred();
    describeCall.mockReturnValueOnce(request.promise);
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    expectLoading();
    await act(async () => request.resolve(context));
    expect(container.querySelector('[data-testid="workspace-files"]')).not.toBeNull();
  });

  it("never commits a stale unavailable reason when a settled context is invalidated", async () => {
    const snapshots: (string | null)[] = [];
    function Observe({ computer }: { computer: ComputerStatus }) {
      useLayoutEffect(() => {
        snapshots.push(container.textContent);
      });
      return <WorkspacePane {...props} computer={computer} />;
    }
    await act(async () => root.render(<Observe computer={graphicalComputer} />));
    expect(container.textContent).toContain("Files are unavailable on this computer.");
    snapshots.length = 0;
    const request = deferred();
    describeCall.mockReturnValueOnce(request.promise);
    await act(async () =>
      root.render(<Observe computer={{ ...graphicalComputer, homeRevision: "new-revision" }} />),
    );
    expectLoading();
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot).toContain("Loading…");
      expect(snapshot).not.toContain("Files are unavailable on this computer.");
      expect(snapshot).not.toContain("Retry");
    }
    await act(async () => request.resolve(context));
    expect(container.querySelector('[data-testid="workspace-files"]')).not.toBeNull();
  });

  it.each(["bot", "computer", "connection", "kind", "homeRevision", "state"] as const)(
    "waits for the new context when %s changes and ignores an aborted response",
    async (change) => {
      const previous = deferred();
      describeCall.mockReturnValueOnce(previous.promise);
      await act(async () => root.render(<WorkspacePane {...props} />));
      const request = deferred();
      describeCall.mockReturnValueOnce(request.promise);
      const nextBot = change === "bot" ? { ...bot, id: "bot-2" } : bot;
      const nextComputer = {
        ...graphicalComputer,
        ...(change === "computer" ? { computerId: "computer-2" } : {}),
        ...(change === "connection" ? { connectionId: "container-connection" } : {}),
        ...(change === "kind" ? { kind: "desktop" as const } : {}),
        ...(change === "homeRevision" ? { homeRevision: "new-revision" } : {}),
        ...(change === "state" ? { state: "stopped" as const } : {}),
      };
      await act(async () =>
        root.render(<WorkspacePane {...props} bot={nextBot} computer={nextComputer} />),
      );
      expectLoading();
      await act(async () => previous.resolve({ ...context, files: "unavailable" }));
      expectLoading();
      await act(async () =>
        request.resolve({
          ...context,
          botId: nextBot.id,
          computerId: nextComputer.computerId ?? null,
        }),
      );
      expect(container.querySelector('[data-testid="workspace-files"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Files are unavailable on this computer.");
    },
  );
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
