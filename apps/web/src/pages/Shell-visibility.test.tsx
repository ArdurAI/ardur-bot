// @vitest-environment jsdom
// Behavioural coverage for the workspace pane's screen-visibility rules. These
// render the real ShellPage against a scripted RPC surface and assert on the
// requests the shell actually makes (screen, heartbeat, boot, takeover) and on
// the keep-alive interval it really holds — never on Shell.tsx's source text.
import type {
  Bot,
  ComputerStatus,
  Group,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
} from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const computerFor = (botId: string, graphical: boolean): ComputerStatus => ({
  botId,
  computerId: `computer-${botId}`,
  mode: "team",
  kind: graphical ? "e2b" : "kubernetes",
  state: "running",
  capabilities: { graphical, interactiveTerminal: !graphical },
  controlHolder: "none",
  controlBotId: null,
  takeoverRequested: false,
  screenAvailable: graphical,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: "saved",
  busyBotName: null,
  canUpdate: false,
});

const snapshotFor = (botId: string, graphical: boolean): ThreadSnapshot => ({
  threadId: `thread-${botId}`,
  cursor: 0,
  messages: [],
  olderCursor: null,
  botId,
  run: null,
  computer: computerFor(botId, graphical),
});

const botFor = (id: string, name: string): Bot => ({
  id,
  spaceId: "space-1",
  name,
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
  threadId: `thread-${id}`,
  preview: "",
  status: "idle",
  computerMode: "team",
  updatedAt: "2026-09-28T00:00:00Z",
  createdAt: "2026-09-28T00:00:00Z",
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
});

const state = vi.hoisted(
  () =>
    ({}) as {
      bots: Bot[];
      groups: Group[];
      threads: Record<string, ThreadSnapshot>;
      calls: string[];
      screenRequestedBots: string[];
      bootstrapBotId?: string;
      bootstrapGate?: Promise<void>;
      bootstrapThread?: ThreadSnapshot;
      takeoverRejections: number;
      takeoverFailures: number;
      terminalAvailable: boolean;
    },
);
state.bots = [botFor("bot-1", "Graphical"), botFor("bot-2", "Plain")];
state.groups = [];
state.threads = {
  "bot-1": snapshotFor("bot-1", true),
  "bot-2": snapshotFor("bot-2", false),
};
state.calls = [];
state.screenRequestedBots = [];
state.takeoverRejections = 0;
state.takeoverFailures = 0;

const TAKEOVER_BUSY_MESSAGE = "A run is still active on this computer";

/** Pushes real ProductEvents into the mocked threads.subscribe stream. */
const bus = vi.hoisted(() => {
  const queue: ProductEvent[] = [];
  const waiting: Array<() => void> = [];
  let seq = 0;
  return {
    nextSeq() {
      return seq + 1;
    },
    push(botId: string, type: string, payload: Record<string, unknown> = {}) {
      seq += 1;
      queue.push({
        id: `event-${seq}`,
        spaceId: "space-1",
        threadId: `thread-${botId}`,
        botId,
        seq,
        type,
        runId: `run-${seq}`,
        createdAt: "2026-09-28T00:00:00Z",
        payload,
      } as ProductEvent);
      for (const wake of waiting.splice(0)) wake();
    },
    stream: {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next(): Promise<IteratorResult<ProductEvent>> {
            if (index < queue.length) return { value: queue[index++]!, done: false };
            await new Promise<void>((resolve) => waiting.push(resolve));
            return { value: queue[index++]!, done: false };
          },
        };
      },
    },
  };
});

vi.mock("../lib/rpc", () => {
  const record = (name: string) => {
    // Record synchronously so interval callbacks can be identified by what
    // they fire, without waiting a microtask for an async wrapper; read the
    // shared state lazily because this factory is hoisted above its setup.
    const call = () => {
      state.calls.push(name);
      return undefined as unknown;
    };
    return () => Promise.resolve(call());
  };
  return {
    rpc: {
      bootstrap: async () => {
        state.calls.push("bootstrap");
        await state.bootstrapGate;
        return {
          me: {
            userId: "user-1",
            email: "owner@example.test",
            name: "Owner",
            spaceId: "space-1",
            isDeploymentOwner: true,
            needsModel: false,
            defaultProvider: null,
            defaultModel: null,
            computerHost: null,
            canChooseHostComputer: false,
            sandboxProvider: "fake",
            avatarStyle: "robot",
          },
          bots: state.bots,
          groups: state.groups,
          botSections: [],
          archivedBots: [],
          archivedGroups: [],
          thread: state.bootstrapThread ?? state.threads[state.bootstrapBotId ?? "bot-1"] ?? null,
          routines: [],
          spaces: [
            {
              id: "space-1",
              name: "Space",
              isDefault: true,
              hasContent: true,
              bots: state.bots,
              groups: state.groups,
              botSections: [],
            },
          ],
        };
      },
      spaces: {
        list: async () => ({
          current: {
            id: "space-1",
            name: "Space",
            bots: state.bots,
            groups: state.groups,
            externalConversations: [],
            botSections: [],
          },
          spaces: [
            {
              id: "space-1",
              name: "Space",
              isDefault: true,
              hasContent: true,
              bots: state.bots,
              groups: state.groups,
              botSections: [],
            },
          ],
        }),
      },
      threads: {
        get: async (input: { botId?: string; groupId?: string }) => {
          state.calls.push("threads.get");
          return state.threads[input.groupId ?? input.botId ?? "bot-1"] ?? null;
        },
        head: record("threads.head"),
        subscribe: async () => {
          state.calls.push("threads.subscribe");
          return bus.stream;
        },
        messages: record("threads.messages"),
        markRead: record("threads.markRead"),
        markUnread: record("threads.markUnread"),
        send: record("threads.send"),
        stop: record("threads.stop"),
        answer: record("threads.answer"),
        clear: record("threads.clear"),
        react: record("threads.react"),
        followUp: record("threads.followUp"),
        restart: record("threads.restart"),
      },
      computer: {
        connections: async () => [],
        list: async () => [],
        status: async (input?: { botId?: string }) => {
          state.calls.push("computer.status");
          const botId = input?.botId ?? "bot-1";
          return state.threads[botId]?.computer ?? computerFor(botId, true);
        },
        boot: async (input?: { botId?: string }) => {
          state.calls.push("computer.boot");
          const botId = input?.botId ?? "bot-1";
          return state.threads[botId]?.computer ?? computerFor(botId, true);
        },
        stop: record("computer.stop"),
        recover: record("computer.recover"),
        reset: record("computer.reset"),
        update: record("computer.update"),
        updates: async () => [],
        release: record("computer.release"),
        takeover: async () => {
          state.calls.push("computer.takeover");
          state.takeoverRejections += 1;
          if (state.takeoverRejections <= state.takeoverFailures)
            throw new Error(TAKEOVER_BUSY_MESSAGE);
          return { leaseId: "lease", expiresAt: "2026-10-01T00:00:00Z" };
        },
        screenUrl: async (input: { botId: string }) => {
          state.calls.push("computer.screenUrl");
          state.screenRequestedBots.push(input.botId);
          return { url: `https://screen.example/${input.botId}` };
        },
        heartbeat: record("computer.heartbeat"),
      },
      routines: { list: record("routines.list") },
      skills: { list: record("skills.list"), stop: record("skills.stop") },
      memory: { providerConfig: record("memory.providerConfig") },
      notifications: { activity: record("notifications.activity") },
      voice: {
        status: record("voice.status"),
        voices: async () => {
          state.calls.push("voice.voices");
          return [];
        },
        catalog: record("voice.catalog"),
      },
      messaging: { status: record("messaging.status") },
      preferences: { get: record("preferences.get"), update: record("preferences.update") },
      me: async () => ({
        userId: "user-1",
        email: "owner@example.test",
        name: "Owner",
        spaceId: "space-1",
        isDeploymentOwner: true,
        needsModel: false,
        defaultProvider: null,
        defaultModel: null,
        computerHost: null,
        canChooseHostComputer: false,
        sandboxProvider: "fake",
        avatarStyle: "robot",
      }),
      models: {
        list: async () => {
          state.calls.push("models.list");
          return [];
        },
        credentials: async () => {
          state.calls.push("models.credentials");
          return [];
        },
      },

      runs: { list: record("runs.list") },
      team: { board: record("team.board") },
      search: { query: record("search.query") },
      integrations: { list: record("integrations.list") },
      mcp: { servers: { list: record("mcp.servers.list") } },
      connectors: { summary: record("connectors.summary") },
      workspace: { describe: record("workspace.describe"), tasks: record("workspace.tasks") },
      terminal: {
        available: async () => ({ available: state.terminalAvailable }),
        ticket: record("terminal.ticket"),
        close: record("terminal.close"),
      },
      goals: { get: record("goals.get") },
      botComms: { getPolicy: async () => null },
      evidence: { runSummary: async () => null },
      onboarding: { promptFocus: record("onboarding.promptFocus") },
      agentSkills: { list: async () => [] },
      connections: {
        list: async () => [],
        catalog: async () => [],
      },
      usage: { summary: record("usage.summary") },
      export: { bot: record("export.bot") },
      artifacts: { create: record("artifacts.create") },
      boards: { list: record("boards.list") },
      board: { view: async () => ({ bots: [], workspaces: [] }) },
      scratchpad: { list: async () => [] },
      delegations: { policy: async () => ({ mode: "any" }) },
      system: { dispatch: record("system.dispatch") },
    },
    selectedSpaceId: () => "space-1",
    selectSpace: () => true,
    clearSpaceSelection: () => undefined,
    withSpaceHeaders: (init?: HeadersInit) => new Headers(init),
  };
});

vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "user-1", name: "Owner" } },
      isPending: false,
      error: null,
    }),
  },
}));
vi.mock("../lib/performance", () => ({ markOnce: vi.fn(), markAfterPaint: vi.fn() }));
vi.mock("./ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("./KnowledgeSection", () => ({ KnowledgeSection: () => null }));
vi.mock("./shell/terminal-session", () => ({
  default: () => {
    useEffect(() => {
      state.calls.push("session.mount");
      return () => {
        state.calls.push("session.close");
      };
    }, []);
    return <div data-pane-session>Shell scrollback</div>;
  },
}));
vi.mock("@lingui/react/macro", () => {
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) =>
    typeof parts === "string"
      ? parts
      : parts.reduce((text, part, i) => text + part + (String(values[i - 1] ?? "") ?? ""), "");
  return {
    Trans: ({ children }: { children: ReactNode }) => children,
    useLingui: () => ({ t: tag }),
  };
});
vi.mock("@lingui/react", () => {
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (String(values[i - 1] ?? "") ?? ""), "");
  return {
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useLingui: () => ({ i18n: { _: (m: unknown) => m, locale: "en" }, t: tag }),
  };
});
vi.mock("@lingui/core/macro", () => {
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, i) => text + part + (String(values[i - 1] ?? "") ?? ""), "");
  return {
    t: tag,
    msg: tag,
    plural: tag,
    select: tag,
    selectOrdinal: tag,
    defineMessage: tag,
  };
});
vi.mock("../components/PreferencesProvider", () => ({
  PreferencesProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  usePreferences: () => ({
    preferences: {},
    ready: true,
    update: async () => {},
    reload: () => {},
  }),
}));

import { ShellPage } from "./Shell";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Heartbeat intervals the shell holds right now (captured via setInterval). */
let liveIntervals: Map<number, { fn: () => void; delay: number }>;
let intervalSeq = 0;
const realSetInterval = window.setInterval;
const realClearInterval = window.clearInterval;
let savedLayouts: Map<string, string>;
let narrowWindow = false;

beforeEach(() => {
  savedLayouts = new Map();
  narrowWindow = false;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => savedLayouts.get(key) ?? null,
      setItem: (key: string, value: string) => savedLayouts.set(key, value),
      removeItem: (key: string) => savedLayouts.delete(key),
      clear: () => savedLayouts.clear(),
    },
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("min-width")
      ? !narrowWindow
      : query.includes("max-width") && narrowWindow,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollTo = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  liveIntervals = new Map();
  intervalSeq = 0;
  window.setInterval = ((fn: () => void, delay?: number, ...rest: unknown[]) => {
    const id = ++intervalSeq;
    if (typeof fn === "function") {
      liveIntervals.set(id, { fn, delay: delay ?? 0 });
      return id as unknown as ReturnType<typeof window.setInterval>;
    }
    return realSetInterval(fn as never, delay, ...(rest as never[]));
  }) as typeof window.setInterval;
  window.clearInterval = ((id: number) => {
    liveIntervals.delete(id);
    return realClearInterval(id);
  }) as typeof window.clearInterval;

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  state.calls.length = 0;
  state.screenRequestedBots = [];
  state.bootstrapBotId = undefined;
  state.bootstrapGate = undefined;
  state.bootstrapThread = undefined;
  state.groups = [];
  state.takeoverRejections = 0;
  state.takeoverFailures = 0;
  state.terminalAvailable = false;
  state.threads = {
    "bot-1": snapshotFor("bot-1", true),
    "bot-2": snapshotFor("bot-2", false),
  };
});

afterEach(async () => {
  window.setInterval = realSetInterval;
  window.clearInterval = realClearInterval;
  root.render(null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  host.remove();
});

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, budgetMs = 5000, step = 50) {
  let waited = 0;
  while (!condition()) {
    if (waited >= budgetMs) throw new Error(`condition not met within ${budgetMs}ms`);
    await tick(step);
    waited += step;
  }
}

const count = (name: string) => state.calls.filter((call) => call === name).length;
const pane = () => host.querySelector('[data-testid="side-panel"]');
const paneTab = (label: string) =>
  [...(pane()?.querySelectorAll('[role="tab"]') ?? [])].find((tab) => tab.textContent === label) ??
  [...host.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );
const overlayTab = (label: string) =>
  [
    ...(host
      .querySelector('[role="tablist"][aria-label="Computer"]')
      ?.querySelectorAll('[role="tab"]') ?? []),
  ].find((tab) => tab.textContent === label);
const click = (element: Element | undefined | null) => {
  if (element) (element as HTMLElement).click();
};

/** The 60-second keep-alive interval, if the shell currently holds one. */
const heartbeatInterval = () =>
  [...liveIntervals.values()].find(({ fn, delay }) => delay === 60_000 && heartbeatFn(fn));
const heartbeatFn = (fn: () => void) => {
  // Identify the ping by what it does: invoking it must hit computer.heartbeat.
  const before = count("computer.heartbeat");
  fn();
  return count("computer.heartbeat") > before;
};

async function renderShell(route: string) {
  root.render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/app/:botId" element={<ShellPage />} />
        <Route path="/app/g/:groupId" element={<ShellPage />} />
        <Route path="/app" element={<ShellPage dashboard />} />
        <Route path="*" element={<ShellPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await until(() => host.querySelector('[data-testid="shell-root"]') !== null);
  await until(() => (host.textContent ?? "").includes("Graphical"));
  await tick(150);
}

async function openWorkspacePane() {
  const agentComputer = [...host.querySelectorAll("button")].find((button) =>
    button.getAttribute("title")?.includes("Agent computer"),
  );
  click(agentComputer);
  await until(() => pane()?.getAttribute("data-panel") === "computer");
  // The pane's tab strip appears once the thread snapshot is committed.
  await until(() => paneTab("Tasks") !== undefined);
  await tick(150);
  return pane();
}

/** Delivers a thread refresh the way a live event does: event → refreshThread → threads.get. */
async function deliverCapabilityFlip(botId: string, graphical: boolean) {
  // The live event advances the thread cursor, so the refreshed snapshot must
  // carry a newer cursor or reconcileRefreshedThread treats it as stale.
  state.threads[botId] = {
    ...snapshotFor(botId, graphical),
    cursor: bus.nextSeq(),
  };
  const seen = count("threads.get");
  bus.push(botId, "run.completed");
  await until(() => count("threads.get") > seen);
  await tick(200);
}

it("opens the dashboard account popover on its first click with the existing actions", async () => {
  root.render(
    <StrictMode>
      <MemoryRouter initialEntries={["/app?view=dashboard"]}>
        <ShellPage dashboard />
      </MemoryRouter>
    </StrictMode>,
  );
  await until(() => host.querySelector('[data-testid="user-menu-trigger"]') !== null);
  click(host.querySelector('[data-testid="user-menu-trigger"]'));
  await until(() => document.querySelector('[data-slot="popover-content"]') !== null);
  const menu = document.querySelector('[data-slot="popover-content"]')!;
  expect([...menu.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Settings",
    "Usage",
    "Log out",
  ]);
  await tick(300);
  expect(document.querySelector('[data-slot="popover-content"]')).toBe(menu);
});

it("keeps Show settings in the workspace header and Show computer returns to the selected view", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  click(paneTab("Screen"));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  const settings = pane()?.querySelector('[aria-label="Show settings"]');
  expect(settings).not.toBeNull();
  click(settings);
  await until(() => pane()?.getAttribute("data-panel") === "settings");
  click(pane()?.querySelector('[aria-label="Show computer"]'));
  await until(() => pane()?.getAttribute("data-panel") === "computer");
  expect(paneTab("Screen")?.getAttribute("aria-selected")).toBe("true");
});

it.each([false, true])(
  "preserves context-menu settings intent across a bot layout change (restored workspace: %s)",
  async (visible) => {
    savedLayouts.set(
      'ardurbot:workspace-layout:["user-1","space-1","bot-2"]',
      JSON.stringify({
        version: 1,
        open: [{ type: "routines" }],
        active: "routines",
        visible,
        expanded: false,
        position: "right",
        width: 480,
        height: 280,
      }),
    );
    await renderShell("/app/bot-1");
    const target = host.querySelector('[data-roster-bot-id="bot-2"]')!;
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await until(() => document.querySelector('[role="menuitem"]') !== null);
    const settings = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Bot settings",
    );
    expect(settings).toBeDefined();
    click(settings);
    await until(() => pane()?.getAttribute("data-panel") === "settings");
    await tick(200);
    expect(pane()?.getAttribute("data-panel")).toBe("settings");
    expect(pane()?.querySelector("input")?.value).toBe("Plain");
  },
);

it("offers Tasks and Routines tabs on first open without overriding remembered closures", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  expect([...pane()!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    "Tasks",
    "Routines",
  ]);
  click(paneTab("Routines"));
  await until(() => paneTab("Routines")?.getAttribute("aria-selected") === "true");
  click(pane()?.querySelector('[aria-label="Close Routines"]'));
  await until(() => pane()?.querySelectorAll('[role="tab"]').length === 1);
  click(host.querySelector("[data-workspace-toggle]"));
  await until(() => pane()?.getAttribute("aria-hidden") === "true");
  click(host.querySelector("[data-workspace-toggle]"));
  await until(() => pane()?.getAttribute("aria-hidden") === "false");
  expect([...pane()!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    "Tasks",
  ]);
});

it("remembers distinct A/B layouts and restores focus when a view closes", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  click(paneTab("Screen"));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  const slider = pane()?.querySelector("hr");
  slider?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await tick(100);
  expect(pane()?.querySelector("hr")?.getAttribute("aria-valuenow")).toBe("500");
  click(host.querySelector('[data-roster-bot-id="bot-2"]'));
  await until(
    () =>
      savedLayouts.has('ardurbot:workspace-layout:["user-1","space-1","bot-2"]') &&
      pane()?.getAttribute("data-panel") === "closed",
  );
  await tick(300);
  await openWorkspacePane();
  expect(pane()?.querySelector("hr")?.getAttribute("aria-valuenow")).toBe("480");
  expect([...pane()!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    "Tasks",
    "Routines",
  ]);
  click(paneTab("Computer"));
  await until(() => paneTab("Computer")?.getAttribute("aria-selected") === "true");
  click(host.querySelector('[data-roster-bot-id="bot-1"]'));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  expect(pane()?.querySelector("hr")?.getAttribute("aria-valuenow")).toBe("500");
  click(pane()?.querySelector('[aria-label="Close Screen"]'));
  await until(() => paneTab("Routines")?.getAttribute("aria-selected") === "true");
  click(pane()?.querySelector('[aria-label="Close Routines"]'));
  await until(() => paneTab("Tasks")?.getAttribute("aria-selected") === "true");
  await tick(100);
  expect(document.activeElement).toBe(paneTab("Tasks"));
  click(pane()?.querySelector('[aria-label="Close Tasks"]'));
  await until(() => pane()?.getAttribute("aria-hidden") === "true");
  await tick(100);
  expect(document.activeElement).toBe(host.querySelector("[data-workspace-toggle]"));
  const layouts = [...savedLayouts.entries()].filter(([key]) =>
    key.startsWith("ardurbot:workspace-layout:"),
  );
  expect(layouts).toHaveLength(2);
}, 30_000);

it.each([true, false])(
  "hiding a terminal retains it and desktop width (narrow: %s)",
  async (narrow) => {
    narrowWindow = narrow;
    state.bootstrapBotId = "bot-2";
    state.terminalAvailable = true;
    state.threads["bot-2"]!.computer = {
      ...computerFor("bot-2", false),
      controlHolder: "user",
      controlBotId: "bot-2",
    };
    await renderShell("/app/bot-2");
    await openWorkspacePane();
    click(paneTab("Terminal"));
    await until(() => host.querySelector("[data-pane-session]") !== null);
    const original = host.querySelector("[data-pane-session]");
    expect(pane()?.getAttribute("data-overlay")).toBe(String(narrow));
    const back = [...(pane()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Back to chat",
    );
    if (narrow) {
      expect(back).toBeDefined();
      click(back);
    } else click(host.querySelector("[data-workspace-toggle]"));
    await until(() => pane()?.getAttribute("aria-hidden") === "true");
    expect(host.querySelector("[data-pane-session]")).toBe(original);
    expect(count("session.close")).toBe(0);
    const authority = [...host.querySelectorAll("span")].find(
      (span) => span.textContent === "You control the computer",
    );
    expect(authority?.closest("aside")).toBeNull();
    click(host.querySelector("[data-workspace-toggle]"));
    await until(() => pane()?.getAttribute("aria-hidden") === "false");
    await until(() => document.activeElement === paneTab("Terminal"));
    expect(host.querySelector("[data-pane-session]")).toBe(original);
    const layout = JSON.parse(
      [...savedLayouts.entries()].find(([key]) => key.startsWith("ardurbot:workspace-layout:"))![1],
    );
    expect(layout.width).toBe(480);
  },
  30_000,
);

function addGroupConversation() {
  state.groups = [
    {
      id: "group-1",
      spaceId: "space-1",
      name: "Review group",
      threadId: "thread-group-1",
      members: state.bots.map((bot) => ({ botId: bot.id, name: bot.name, color: bot.color })),
      preview: "Group reply",
      unread: false,
      pinned: false,
      sectionId: null,
      archivedAt: null,
      createdAt: "2026-09-28T00:00:00Z",
      updatedAt: "2026-09-28T00:00:00Z",
    },
  ];
  state.threads["group-1"] = {
    threadId: "thread-group-1",
    groupId: "group-1",
    cursor: 100,
    olderCursor: null,
    run: null,
    messages: [
      {
        id: "group-question",
        role: "user" as const,
        blocks: [{ kind: "text" as const, text: "Group question" }],
      },
      {
        id: "group-reply",
        role: "bot" as const,
        botId: "bot-1",
        blocks: [{ kind: "text" as const, text: "Group reply" }],
      },
    ].map((message, index) => ({
      ...message,
      threadId: "thread-group-1",
      seq: index,
      createdAt: "2026-09-28T00:00:00Z",
    })),
  };
  state.threads["bot-2"]!.messages = [
    {
      id: "dm-reply",
      threadId: "thread-bot-2",
      role: "bot",
      botId: "bot-2",
      seq: 0,
      createdAt: "2026-09-28T00:00:00Z",
      blocks: [{ kind: "text", text: "Direct reply" }],
    },
  ];
}

const groupRow = () =>
  [...host.querySelectorAll("button")].find(
    (button) =>
      button.textContent?.includes("Review group") && button.textContent?.includes("Group reply"),
  );

it("renders both sides of a group conversation after group → bot → group", async () => {
  addGroupConversation();
  await renderShell("/app/g/group-1");
  await until(() => host.querySelector('[data-message-id="group-reply"]') !== null);
  expect(host.querySelector('[data-message-id="group-question"]')?.textContent).toContain(
    "Group question",
  );
  click(host.querySelector('[data-roster-bot-id="bot-2"]'));
  await until(() => host.querySelector('[data-message-id="dm-reply"]') !== null);
  expect(host.querySelector('[data-message-id="group-reply"]')).toBeNull();
  expect(groupRow()).toBeDefined();
  click(groupRow());
  await until(() => host.querySelector('[data-message-id="group-reply"]') !== null);
  expect(host.querySelector('[data-message-id="group-reply"]')?.textContent).toContain(
    "Group reply",
  );
  expect(host.querySelector('[data-message-id="group-question"]')?.textContent).toContain(
    "Group question",
  );
  expect(host.querySelector('[data-message-id="dm-reply"]')).toBeNull();
});

it("keeps the reopened group visible when the initial bot bootstrap finishes late", async () => {
  addGroupConversation();
  let finishBootstrap!: () => void;
  state.bootstrapGate = new Promise<void>((resolve) => {
    finishBootstrap = resolve;
  });
  const rendered = renderShell("/app/bot-1");
  await until(() => count("bootstrap") > 0);
  window.dispatchEvent(new Event("focus"));
  await rendered;
  click(groupRow());
  await until(() => host.querySelector('[data-message-id="group-reply"]') !== null);
  click(host.querySelector('[data-roster-bot-id="bot-2"]'));
  await until(() => host.querySelector('[data-message-id="dm-reply"]') !== null);
  click(groupRow());
  await until(() => host.querySelector('[data-message-id="group-reply"]') !== null);
  finishBootstrap();
  await tick(200);
  expect(host.querySelector('[data-message-id="group-reply"]')?.textContent).toContain(
    "Group reply",
  );
  expect(host.querySelector('[data-message-id="group-question"]')?.textContent).toContain(
    "Group question",
  );
  expect(groupRow()?.textContent).toContain("Group reply");
});

it("does not erase newer DM replies with an older bootstrap of the same thread", async () => {
  addGroupConversation();
  state.bootstrapBotId = "bot-2";
  state.bootstrapThread = snapshotFor("bot-2", false);
  state.threads["bot-2"]!.cursor = 100;
  let finishBootstrap!: () => void;
  state.bootstrapGate = new Promise<void>((resolve) => {
    finishBootstrap = resolve;
  });
  const rendered = renderShell("/app/bot-2");
  await until(() => count("bootstrap") > 0);
  window.dispatchEvent(new Event("focus"));
  await rendered;
  await until(() => host.querySelector('[data-message-id="dm-reply"]') !== null);
  finishBootstrap();
  await tick(200);
  expect(host.querySelector('[data-message-id="dm-reply"]')?.textContent).toContain("Direct reply");
});

it("retargets group settings when selecting a bot", async () => {
  addGroupConversation();
  await renderShell("/app/g/group-1");
  click(host.querySelector('[data-testid="bot-settings-trigger"]'));
  await until(() => pane()?.getAttribute("data-panel") === "group-settings");
  click(host.querySelector('[data-roster-bot-id="bot-2"]'));
  await until(() => host.querySelector('[data-message-id="dm-reply"]') !== null);
  await until(() => pane()?.getAttribute("data-panel") !== "group-settings");
  expect(pane()?.textContent).not.toContain("Group settings");
  expect(pane()?.getAttribute("data-panel")).toBe("settings");
  await until(() => pane()?.querySelector('input[value="Plain"]') !== null);
  click(groupRow());
  await until(() => pane()?.getAttribute("data-panel") === "group-settings");
  expect(pane()?.textContent).toContain("Group settings");
  expect(pane()?.querySelector('input[value="Review group"]')).not.toBeNull();
});

it("keeps the full bot name while the long model label truncates first", async () => {
  const original = state.bots;
  state.bots = [
    {
      ...original[0]!,
      name: "Graphical Reviewer",
      runtimeKind: "claude-code",
      modelId: "a-very-long-model-label-that-must-shrink-before-the-bot-name",
      thinkingLevel: "high",
    },
    original[1]!,
  ];
  try {
    await renderShell("/app/bot-1");
    const identity = host.querySelector('[data-testid="bot-settings-trigger"]')!;
    const name = [...identity.querySelectorAll("span")].find(
      (entry) => entry.textContent === "Graphical Reviewer" && entry.classList.contains("block"),
    )!;
    expect(name.textContent).toBe("Graphical Reviewer");
    expect(name.classList.contains("truncate")).toBe(false);
    expect(identity.classList.contains("shrink-0")).toBe(true);
    expect(identity.classList.contains("max-w-48")).toBe(true);
    const model = host.querySelector('[aria-label^="Change model:"] .truncate')!;
    expect(model.textContent).toContain("a-very-long-model-label");
  } finally {
    state.bots = original;
  }
});

it("runs the heartbeat only while a screen surface is really rendered across capability transitions", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();

  // Tasks is rendered for a graphical computer: no keep-alive interval exists.
  expect(paneTab("Tasks")?.getAttribute("aria-selected")).toBe("true");
  expect(count("computer.heartbeat")).toBe(0);
  expect(heartbeatInterval()).toBeUndefined();

  // Entering Screen starts the keep-alive: an immediate ping, then a 60s interval.
  click(paneTab("Screen"));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  await tick(100);
  const interval = heartbeatInterval();
  expect(interval).toBeDefined();
  const onScreen = count("computer.heartbeat");
  expect(onScreen).toBeGreaterThan(0);
  const beforeTick = count("computer.heartbeat");
  interval?.fn();
  expect(count("computer.heartbeat")).toBe(beforeTick + 1);

  // Capability loss retains the view with a reason, never an unseen screen.
  await deliverCapabilityFlip("bot-1", false);
  await until(
    () => pane()?.textContent?.includes("Screen is unavailable on this computer.") === true,
  );
  expect(paneTab("Screen")?.getAttribute("aria-selected")).toBe("true");
  expect(heartbeatInterval()).toBeUndefined();
  const afterFlipAway = count("computer.heartbeat");
  await tick(200);
  expect(count("computer.heartbeat")).toBe(afterFlipAway);

  // Non-graphical -> graphical: the retained Screen selection resolves to Screen
  // again, so the visible computer must get its keep-alive back.
  await deliverCapabilityFlip("bot-1", true);
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  await until(() => heartbeatInterval() !== undefined);
  expect(count("computer.heartbeat")).toBeGreaterThan(afterFlipAway);
}, 30_000);

it("keeps the heartbeat off the pane's Computer tab through the reverse transition", async () => {
  // Start non-graphical: the pane offers Computer, whose preview is a screen
  // surface, so viewing it keeps the computer alive.
  state.threads["bot-1"] = snapshotFor("bot-1", false);
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  click(paneTab("Computer"));
  await until(() => paneTab("Computer")?.getAttribute("aria-selected") === "true");
  await until(() => heartbeatInterval() !== undefined);
  const onComputerTab = count("computer.heartbeat");
  expect(onComputerTab).toBeGreaterThan(0);

  // The unavailable Computer view stays selected, but its keep-alive stops.
  await deliverCapabilityFlip("bot-1", true);
  await until(() => pane()?.textContent?.includes("Open Screen to view this computer.") === true);
  expect(paneTab("Computer")?.getAttribute("aria-selected")).toBe("true");
  expect(heartbeatInterval()).toBeUndefined();
  const afterFlip = count("computer.heartbeat");
  await tick(200);
  expect(count("computer.heartbeat")).toBe(afterFlip);
}, 30_000);

it("does not request a screen for a computer whose capability no longer supports the rendered tab", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  click(paneTab("Screen"));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  await tick(150);
  const graphicalScreens = count("computer.screenUrl");
  expect(graphicalScreens).toBeGreaterThan(0);

  // Graphical -> non-graphical with Screen retained: the refresh commits the new
  // computer before React re-renders; no request may leave for it.
  await deliverCapabilityFlip("bot-1", false);
  await until(
    () => pane()?.textContent?.includes("Screen is unavailable on this computer.") === true,
  );
  await tick(150);
  expect(count("computer.screenUrl")).toBe(graphicalScreens);

  // Non-graphical -> graphical: Screen becomes the rendered tab again. The pane
  // keeps its cached screen URL, so the assertion is that the surface returns
  // (and nothing extra was requested while it was hidden).
  await deliverCapabilityFlip("bot-1", true);
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
}, 30_000);

it("does not request a screen when the retained Computer tab stops being supported", async () => {
  state.threads["bot-1"] = snapshotFor("bot-1", false);
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  click(paneTab("Computer"));
  await until(() => paneTab("Computer")?.getAttribute("aria-selected") === "true");
  await tick(150);
  const beforeFlip = count("computer.screenUrl");
  expect(beforeFlip).toBeGreaterThan(0);

  // Non-graphical -> graphical with Computer retained resolves to Tasks; the
  // just-committed graphical computer must not be asked for a screen.
  await deliverCapabilityFlip("bot-1", true);
  await until(() => pane()?.textContent?.includes("Open Screen to view this computer.") === true);
  await tick(150);
  expect(count("computer.screenUrl")).toBe(beforeFlip);
}, 30_000);

it("does not request a screen during a fast switch to a bot without one", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  click(paneTab("Screen"));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  await tick(150);
  const beforeSwitch = count("computer.screenUrl");
  expect(beforeSwitch).toBeGreaterThan(0);

  // Switch bots while the pane is open and Screen is retained: bot-2's computer
  // is non-graphical, so its arriving thread must not trigger a screen request.
  const botRow = host.querySelector<HTMLButtonElement>('[data-roster-bot-id="bot-2"]');
  expect(botRow).not.toBeNull();
  click(botRow);
  // MemoryRouter keeps its own history, so watch the pane instead: bot-2's
  // non-graphical computer replaces the Screen tab with the Computer tab.
  await tick(300);
  await openWorkspacePane();
  await until(() => paneTab("Tasks")?.getAttribute("aria-selected") === "true");
  await tick(250);
  expect(count("computer.screenUrl")).toBe(beforeSwitch);
}, 30_000);

it("shows a rejected Take control in the screen, terminal and non-graphical full-window views", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  click(paneTab("Screen"));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  await tick(150);

  // Open the full window (view-only path: no boot, no takeover yet).
  const openScreen = [...host.querySelectorAll('[data-testid="computer-preview-open"]')].at(-1);
  click(openScreen);
  await until(() => overlayTab("Screen") !== undefined);
  await tick(150);
  expect(count("computer.boot")).toBe(0);
  expect(count("computer.takeover")).toBe(0);

  // Take control is rejected by the server: the failure must be visible above
  // the screen content, not hidden inside the screen-only branch.
  state.takeoverFailures = 1;
  const takeControlButton = [...host.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "Take control",
  );
  click(takeControlButton);
  await until(() => (host.textContent ?? "").includes(TAKEOVER_BUSY_MESSAGE));
  expect(count("computer.takeover")).toBeGreaterThan(0);

  // The same failure stays visible on the terminal view of the full window.
  click(overlayTab("Terminal"));
  await until(() => overlayTab("Terminal")?.getAttribute("aria-selected") === "true");
  await tick(100);
  expect(host.textContent).toContain(TAKEOVER_BUSY_MESSAGE);

  // And on the non-graphical view after the capability flips underneath it.
  await deliverCapabilityFlip("bot-1", false);
  click(overlayTab("Screen"));
  await until(() => (host.textContent ?? "").includes("Not available on this computer"));
  expect(host.textContent).toContain(TAKEOVER_BUSY_MESSAGE);
}, 30_000);

it("entering the Screen tab neither boots the computer nor takes control", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  await tick(100);
  expect(count("computer.boot")).toBe(0);
  expect(count("computer.takeover")).toBe(0);

  click(paneTab("Screen"));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  await tick(200);
  expect(count("computer.boot")).toBe(0);
  expect(count("computer.takeover")).toBe(0);
  // The rendered tab fetches its screen instead.
  expect(count("computer.screenUrl")).toBeGreaterThan(0);
}, 30_000);

it("keeps the pane shell across views and expansion, and confirms explicit panel close", async () => {
  state.bootstrapBotId = "bot-2";
  state.terminalAvailable = true;
  state.threads["bot-2"]!.computer = {
    ...computerFor("bot-2", false),
    controlHolder: "user",
    controlBotId: "bot-2",
  };
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await renderShell("/app/bot-2");
    await openWorkspacePane();
    expect(count("session.mount")).toBe(0);
    click(paneTab("Terminal"));
    await until(() => host.querySelector("[data-pane-session]") !== null);
    const original = host.querySelector("[data-pane-session]");
    click(paneTab("Tasks"));
    await tick(100);
    expect(host.querySelector("[data-pane-session]")).toBe(original);
    expect(pane()?.textContent).toContain("You control the computer");
    click(pane()?.querySelector('[aria-label="Expand"]'));
    await tick(100);
    expect(host.querySelector("[data-pane-session]")).toBe(original);
    expect(confirm).not.toHaveBeenCalled();
    click(pane()?.querySelector('[aria-label="Close Terminal"]'));
    await tick(100);
    expect(confirm).toHaveBeenCalledExactlyOnceWith("End this terminal?");
    expect(pane()?.getAttribute("aria-hidden")).toBe("false");
    expect(count("session.close")).toBe(0);
    confirm.mockReturnValue(true);
    click(pane()?.querySelector('[aria-label="Close Terminal"]'));
    await until(() => count("session.close") === 1);
    expect(count("session.mount")).toBe(1);
    expect(count("computer.release")).toBe(0);
  } finally {
    confirm.mockRestore();
  }
}, 30_000);

it("confirms a bot switch before ending the pane shell", async () => {
  state.bootstrapBotId = "bot-2";
  state.terminalAvailable = true;
  state.threads["bot-2"]!.computer = {
    ...computerFor("bot-2", false),
    controlHolder: "user",
    controlBotId: "bot-2",
  };
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  try {
    await renderShell("/app/bot-2");
    await openWorkspacePane();
    click(paneTab("Terminal"));
    await until(() => host.querySelector("[data-pane-session]") !== null);
    click(host.querySelector('[data-roster-bot-id="bot-1"]'));
    await tick(100);
    expect(confirm).toHaveBeenCalledExactlyOnceWith("End this terminal?");
    expect(count("session.close")).toBe(0);
    confirm.mockReturnValue(true);
    click(host.querySelector('[data-roster-bot-id="bot-1"]'));
    await until(() => count("session.close") === 1);
    expect(count("computer.release")).toBe(0);
  } finally {
    confirm.mockRestore();
  }
}, 30_000);

it("does not request a screen for a background bot while the full-window view is open for another bot", async () => {
  state.bootstrapBotId = "bot-2";
  state.threads["bot-2"] = {
    ...snapshotFor("bot-2", false),
    messages: [
      {
        id: "msg-1",
        runId: "run-1",
        role: "bot",
        botId: "bot-1",
        text: "bot-1 card",
        createdAt: "2026-09-28T00:00:00Z",
        blocks: [{ kind: "computer", state: "Ready", text: "Ready" }],
      } as unknown as ThreadMessage,
    ],
  };
  await renderShell("/app/bot-2");
  await until(() => host.querySelector('[data-testid="computer-card-open"]') !== null);
  const openCardButton = host.querySelector<HTMLButtonElement>(
    '[data-testid="computer-card-open"]',
  );
  expect(openCardButton).not.toBeNull();
  click(openCardButton);
  await until(() => overlayTab("Screen") !== undefined);
  await until(() => count("computer.screenUrl") > 0);
  await tick(100);

  const screensBefore = count("computer.screenUrl");
  // Trigger a refresh for the background bot (bot-2) while full-window view is open for bot-1
  await deliverCapabilityFlip("bot-2", false);
  expect(count("computer.screenUrl")).toBe(screensBefore);
  expect(state.screenRequestedBots).not.toContain("bot-2");
}, 30_000);

it("does not request a screen when the full-window view is on the Terminal tab", async () => {
  await renderShell("/app/bot-1");
  await openWorkspacePane();
  click(paneTab("Screen"));
  await until(() => paneTab("Screen")?.getAttribute("aria-selected") === "true");
  await tick(150);

  const openScreen = [...host.querySelectorAll('[data-testid="computer-preview-open"]')].at(-1);
  click(openScreen);
  await until(() => overlayTab("Screen") !== undefined);
  await tick(150);

  // Switch to the Terminal tab in the full-window view
  click(overlayTab("Terminal"));
  await until(() => overlayTab("Terminal")?.getAttribute("aria-selected") === "true");
  await tick(100);

  const beforeRefresh = count("computer.screenUrl");
  // Trigger a refresh while Terminal is selected: screen is unmounted, so no request
  await deliverCapabilityFlip("bot-1", true);
  expect(count("computer.screenUrl")).toBe(beforeRefresh);

  // Switch back to the screen tab and trigger a refresh: assert one request
  click(overlayTab("Screen"));
  await until(() => overlayTab("Screen")?.getAttribute("aria-selected") === "true");
  await tick(100);
  await deliverCapabilityFlip("bot-1", true);
  expect(count("computer.screenUrl")).toBe(beforeRefresh + 1);
}, 30_000);
