// @vitest-environment jsdom

import type { IntegrationCatalogList } from "@ardurbot/contracts";
import { connectionOverview } from "@ardurbot/core";
import type { MessageDescriptor } from "@lingui/core";
import type { ComponentProps, ReactNode } from "react";
import { act, lazy } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearDashboardCache, DashboardPage, DashboardPanelView } from "./DashboardPage";
import { getDashboardPanels } from "./panels";

const api = vi.hoisted(() => ({
  team: vi.fn(),
  work: vi.fn(),
  filingOutcomes: vi.fn(),
  now: vi.fn(),
  runs: vi.fn(),
  thread: vi.fn(),
  answer: vi.fn(),
  subscribe: vi.fn(),
  host: vi.fn(),
  computers: vi.fn(),
  engines: vi.fn(),
  engine: vi.fn(),
  connections: vi.fn(),
  routines: vi.fn(),
  usage: vi.fn(),
  learning: vi.fn(),
  features: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    team: { board: api.team },
    board: { work: api.work, filingOutcomes: api.filingOutcomes },
    runs: { list: api.runs },
    threads: { get: api.thread, answer: api.answer, subscribe: api.subscribe },
    host: { status: api.host },
    computer: { list: api.computers, connections: api.engines, engine: api.engine },
    dashboard: { now: api.now, connections: api.connections },
    routines: { overview: api.routines },
    usage: { summary: api.usage },
    learning: { list: api.learning },
    features: { list: api.features },
  },
}));
const translate = (parts: TemplateStringsArray, ...values: unknown[]) =>
  parts.reduce((text, part, i) => text + part + (values[i] ?? ""), "");
vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => ({ id: parts.join(""), message: parts.join("") }),
  t: (...args: Parameters<typeof translate>) => translate(...args),
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: (value: MessageDescriptor) => value.message ?? value.id } }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: translate }),
}));
vi.mock("@ardurbot/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const period = { records: 2, inputTokens: 30, outputTokens: 10, cost: null };
const summary = {
  inputTokens: 30,
  outputTokens: 10,
  runs: 2,
  dayStart: "2026-09-24T00:00:00Z",
  weekStart: "2026-09-21T00:00:00Z",
  asOf: "2026-09-24T12:00:00Z",
  providers: [],
};
const actions = { openSettings: vi.fn(), openLearning: vi.fn() };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  clearDashboardCache();
  api.team.mockResolvedValue({ rows: [] });
  api.now.mockResolvedValue({ rows: [], runs: [], approvals: [] });
  api.runs.mockResolvedValue({ runs: [] });
  api.host.mockResolvedValue({ connected: false, configured: false, roots: [], health: null });
  api.computers.mockResolvedValue([]);
  api.engines.mockResolvedValue([]);
  api.connections.mockResolvedValue([]);
  api.routines.mockResolvedValue({ next: [], recent: [] });
  api.usage.mockResolvedValue(summary);
  api.learning.mockResolvedValue({ pendingCount: 0, proposals: [] });
  api.work.mockResolvedValue({ workspace: null, ready: 0, inProgress: 0, blocked: 0, items: [] });
  api.filingOutcomes.mockResolvedValue({ bots: [] });
  api.features.mockResolvedValue([{ feature: "governance", state: "unavailable" }]);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});
async function renderPage(scope = "viewer:space") {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <DashboardPage scope={scope} spaceId="space" openSettings={actions.openSettings} />
      </MemoryRouter>,
    ),
  );
  await act(() => vi.dynamicImportSettled());
  await vi.waitFor(() => expect(node.querySelectorAll('[aria-busy="true"]').length).toBe(0));
}
it("loads eight independent lazy panels and renders honest empty states", async () => {
  await renderPage();
  expect(node.querySelectorAll("[data-panel]").length).toBe(8);
  for (const text of [
    "Nothing running",
    "This computer",
    "Not connected",
    "0 folders",
    "No connections",
    "No scheduled runs",
    "No usage",
    "Inbox (0)",
    "No proposals",
  ])
    expect(node.textContent).toContain(text);
  const governance = node.querySelector('[data-panel="governance"]')!;
  expect(governance.querySelector("p")?.textContent).toBe(
    "Governance and encryption are not part of this build yet.",
  );
  expect(governance.querySelector("a")?.getAttribute("href")).toContain("governance.md");
  expect(governance.querySelector("button, input, select")).toBeNull();
});
it.each([1, 12, 100])("bounds persistent requests with %s bot threads", async (count) => {
  let active = 0;
  let peak = 0;
  api.subscribe.mockImplementation(async (_input, { signal }: { signal: AbortSignal }) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    active -= 1;
    return (async function* () {})();
  });
  api.now.mockResolvedValue({
    runs: [],
    approvals: [],
    rows: Array.from({ length: count }, (_, index) => ({
      botId: `bot-${index}`,
      threadId: `thread-${index}`,
      cursor: 0,
      delegations: [],
    })),
  });
  await renderPage();
  expect(node.textContent).toContain("Nothing running");
  expect(peak).toBeLessThanOrEqual(1);
  expect(api.now).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  expect(active).toBe(0);
});
it("paints the layout before bootstrap without starting unscoped panel requests", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <DashboardPage scope="" openSettings={actions.openSettings} />
      </MemoryRouter>,
    ),
  );
  expect(node.querySelector("h1")?.textContent).toBe("Dashboard");
  expect(Array.from(node.querySelectorAll("h2"), (heading) => heading.textContent)).toEqual([
    "Now",
    "Work",
    "Computers",
    "Connections",
    "Routines",
    "Usage",
    "Learning",
    "Governance",
  ]);
  expect(node.querySelectorAll('[aria-busy="true"]')).toHaveLength(8);
  for (const request of Object.values(api)) expect(request).not.toHaveBeenCalled();
  await renderPage();
  expect(node.querySelector('[aria-busy="true"]')).toBeNull();
  expect(api.features).toHaveBeenCalledOnce();
});
it("keeps headings and neighboring panels visible while a widget renderer is suspended", async () => {
  let resolveWidget!: (module: { default: () => ReactNode }) => void;
  const Deferred = lazy(
    () =>
      new Promise<{ default: () => ReactNode }>((resolve) => {
        resolveWidget = resolve;
      }),
  );
  const base = getDashboardPanels().find((panel) => panel.id === "usage")!;
  const pending = { ...base, load: async () => ({}), render: () => <Deferred /> };
  const ready = {
    ...base,
    id: "ready",
    load: async () => ({}),
    render: () => <p>Ready widget</p>,
  };
  await act(async () =>
    root.render(
      <>
        <DashboardPanelView panel={pending} scope="viewer:space" spaceId="space" {...actions} />
        <DashboardPanelView panel={ready} scope="viewer:space" spaceId="space" {...actions} />
      </>,
    ),
  );
  const usage = node.querySelector('[data-panel="usage"]')!;
  expect(usage.querySelector("h2")?.textContent).toBe("Usage");
  expect(usage.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(node.textContent).toContain("Ready widget");
  await act(async () => resolveWidget({ default: () => <p>Loaded widget</p> }));
  expect(usage.textContent).toContain("Loaded widget");
  expect(usage.querySelector('[aria-busy="true"]')).toBeNull();
});
it("uses native registered folders and saved engine state without probing owner-only controls", async () => {
  vi.stubGlobal("ardurbotDesktop", {
    host: { state: async () => ({ configured: true, roots: ["fixture-root", "another-root"] }) },
  });
  api.engines.mockResolvedValue([{ id: "engine", name: "Saved engine", status: "error" }]);
  await renderPage();
  const computers = node.querySelector('[data-panel="computers"]')!;
  expect(computers.textContent).toContain("2 folders");
  expect(computers.textContent).toContain("Saved engine");
  expect(computers.textContent).toContain("Error");
  expect(api.engine).not.toHaveBeenCalled();
});
it.each([
  ["integration", "integrations"],
  ["mcp", "mcp"],
  ["device", "devices"],
  ["channel", "messaging"],
])("opens the matching settings for a %s connection", async (kind, section) => {
  api.connections.mockResolvedValue([
    { id: "connection", name: "Saved connection", kind, state: "connected" },
  ]);
  await renderPage();
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Saved connection"))!
      .click(),
  );
  expect(actions.openSettings).toHaveBeenCalledWith(section);
});
it.each([
  ["now", "now", "Nothing running"],
  ["computers", "host", "This computer"],
  ["connections", "connections", "No connections"],
  ["routines", "routines", "No scheduled runs"],
  ["usage", "usage", "No usage"],
  ["learning", "learning", "No proposals"],
  ["governance", "features", "Governance and encryption are not part of this build yet."],
] as const)(
  "isolates %s loading and failure, then retries to its empty projection",
  async (id, source, empty) => {
    let reject!: (reason: Error) => void;
    api[source].mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    const panel = getDashboardPanels().find((entry) => entry.id === id)!;
    await act(async () =>
      root.render(
        <MemoryRouter>
          <DashboardPanelView panel={panel} scope="viewer:space" spaceId="space" {...actions} />
        </MemoryRouter>,
      ),
    );
    await vi.waitFor(() => expect(reject).toBeDefined());
    expect(node.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => reject(new Error("offline fixture")));
    expect(node.textContent).toContain("Could not load");
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    await vi.waitFor(() => expect(node.textContent).toContain(empty));
    expect(node.querySelector('[role="alert"]')).toBeNull();
  },
);
it("renders panel data and answers through the real chat approval card and thread RPC", async () => {
  const run = {
    runId: "run",
    botId: "bot",
    botName: "Reviewer",
    threadId: "thread",
    groupId: null,
    status: "waiting_input",
    promptSnippet: "Review the draft",
    startedAt: "2026-09-24T00:00:00Z",
  };
  api.runs.mockResolvedValue({ runs: [run] });
  api.now.mockResolvedValue({
    rows: [],
    runs: [run],
    approvals: [{ ...approval(run.runId), messageId: "message" }],
  });
  api.thread.mockResolvedValue({
    run: { id: "run", status: "waiting_input" },
    messages: [
      {
        id: "message",
        runId: "run",
        blocks: [
          {
            kind: "ask",
            status: "pending",
            text: "Send the draft?",
            approvalEffectId: "effect",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          },
        ],
      },
    ],
  });
  api.answer.mockResolvedValue({ ok: true });
  api.host.mockResolvedValue({
    connected: true,
    configured: true,
    roots: ["fixture-root"],
    health: null,
  });
  api.computers.mockResolvedValue([
    { botId: "bot", name: "Team computer", status: { state: "running", computerId: "computer" } },
  ]);
  api.engines.mockResolvedValue([{ id: "engine", name: "Local engine", status: "connected" }]);
  api.engine.mockResolvedValue({ name: "docker" });
  api.connections.mockResolvedValue([
    { id: "link", name: "Calendar", kind: "integration", state: "needs-sign-in" },
  ]);
  api.routines.mockResolvedValue({
    next: [{ id: "routine", botId: "bot", name: "Daily review", at: "2026-09-25T12:00:00Z" }],
    recent: [
      {
        id: "routine",
        botId: "bot",
        name: "Daily review",
        runId: "prior",
        at: "2026-09-24T12:00:00Z",
        status: "failed",
      },
    ],
  });
  api.usage.mockResolvedValue({
    ...summary,
    providers: [
      {
        provider: "Local provider",
        today: period,
        week: period,
        daily: [{ date: "2026-09-24", records: 2, tokens: 40 }],
      },
    ],
  });
  api.learning.mockResolvedValue({
    pendingCount: 1,
    proposals: [{ id: "proposal", rationale: "Keep the preferred format" }],
  });
  await renderPage();
  for (const text of [
    "Reviewer",
    "Review the draft",
    "Waiting for your approval",
    "1 folders",
    "Team computer",
    "Running",
    "Local engine",
    "Needs sign-in",
    "Daily review",
    "Failed",
    "2 usage records",
    "40 tokens",
    "Keep the preferred format",
  ])
    expect(node.textContent).toContain(text);
  expect(node.querySelector("svg polyline")).not.toBeNull();
  expect(node.textContent).not.toContain("Cost:");
  expect(node.querySelector('[data-panel="now"] a')?.getAttribute("href")).toBe("/app/bot");
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === "Allow once")!
      .click(),
  );
  expect(api.answer).toHaveBeenCalledWith(
    { botId: "bot", threadId: "thread", runId: "run", messageId: "message", answer: "allow" },
    { context: { spaceId: "space" } },
  );
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Calendar"))!
      .click(),
  );
  expect(actions.openSettings).toHaveBeenCalledWith("integrations");
});
it.each([null, "group"])(
  "declines a delegated approval in its coordinator conversation (%s)",
  async (groupId) => {
    const approvalTarget = { botId: "coordinator", threadId: "coordinator-thread", groupId };
    const run = {
      runId: "child-run",
      botId: "worker",
      botName: "Worker",
      threadId: "child-thread",
      groupId: null,
      status: "waiting_input",
      promptSnippet: "Review",
      approvalTarget,
    };
    api.runs.mockResolvedValue({ runs: [run] });
    api.now.mockResolvedValue({
      rows: [],
      runs: [run],
      approvals: [{ ...approval(run.runId), messageId: "coordinator-card" }],
    });
    api.thread.mockResolvedValue({
      run: null,
      activeRuns: [],
      messages: [
        {
          id: "coordinator-card",
          runId: "child-run",
          blocks: [
            {
              kind: "ask",
              status: "pending",
              text: "Send?",
              approvalEffectId: "effect",
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        },
      ],
    });
    api.answer.mockResolvedValue({ ok: true });
    await renderPage();
    const target = groupId ? { groupId } : { botId: "coordinator", threadId: "coordinator-thread" };
    expect(api.now).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ context: { spaceId: "space" } }),
    );
    await act(async () =>
      [...node.querySelectorAll("button")].find((button) => button.textContent === "Deny")!.click(),
    );
    expect(api.answer).toHaveBeenCalledWith(
      { ...target, runId: "child-run", messageId: "coordinator-card", answer: "deny" },
      { context: { spaceId: "space" } },
    );
  },
);
it("keeps warm content immediately available, below the 200 ms render budget, and separates viewers", async () => {
  await renderPage();
  await act(async () => root.render(null));
  const calls = api.features.mock.calls.length;
  const start = performance.now();
  await act(async () =>
    root.render(
      <MemoryRouter>
        <DashboardPage scope="viewer:space" spaceId="space" openSettings={actions.openSettings} />
      </MemoryRouter>,
    ),
  );
  const elapsed = performance.now() - start;
  expect(node.querySelector('[aria-busy="true"]')).toBeNull();
  expect(api.features).toHaveBeenCalledTimes(calls);
  expect(elapsed).toBeLessThan(200);
  await renderPage("another:space");
  expect(api.features).toHaveBeenCalledTimes(calls + 1);
});

function waitingRun(runId: string, extra = {}) {
  return {
    runId,
    botId: "bot",
    botName: "Reviewer",
    threadId: "thread",
    groupId: null,
    groupName: null,
    status: "waiting_input",
    trigger: "user",
    notificationsEnabled: false,
    promptSnippet: `Review ${runId}`,
    updatedAt: "2026-09-24T00:00:00Z",
    ...extra,
  };
}
function approval(runId: string) {
  return {
    runId,
    messageId: `message-${runId}`,
    block: {
      kind: "ask",
      status: "pending",
      text: `Approve ${runId}?`,
      approvalEffectId: `effect-${runId}`,
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    },
  };
}
it.each(["newest run only", "approval outside message page"])(
  "renders all pending approvals despite a snapshot with %s",
  async (snapshotCase) => {
    const runs = [waitingRun("older"), waitingRun("newer")];
    const approvals = runs.map((run) => approval(run.runId));
    api.now.mockResolvedValue({ rows: [], runs, approvals });
    api.runs.mockResolvedValue({ runs });
    api.thread.mockResolvedValue({
      run: { id: "newer", status: "waiting_input" },
      messages:
        snapshotCase === "newest run only"
          ? approvals.map((item) => ({
              id: item.messageId,
              runId: item.runId,
              blocks: [item.block],
            }))
          : Array.from({ length: 100 }, (_, seq) => ({
              id: `later-${seq}`,
              runId: "newer",
              blocks: [{ kind: "text", text: "Progress" }],
            })),
    });
    await renderPage();
    expect(node.textContent).toContain("Approve older?");
    expect(node.textContent).toContain("Approve newer?");
    expect(
      [...node.querySelectorAll("button")].filter((button) => button.textContent === "Allow once"),
    ).toHaveLength(2);
    expect(api.thread).not.toHaveBeenCalled();
  },
);
it("opens group runs in their group conversation", async () => {
  const runs = [waitingRun("group-run", { groupId: "group", status: "running" })];
  api.now.mockResolvedValue({ rows: [], runs, approvals: [] });
  api.runs.mockResolvedValue({ runs });
  await renderPage();
  expect(node.querySelector('[data-panel="now"] a')?.getAttribute("href")).toBe("/app/g/group");
});
it("opens external runs through ChatTaskReview with their isolated thread", async () => {
  const runs = [
    waitingRun("external-run", {
      externalThread: true,
      threadId: "external-thread",
      status: "running",
    }),
  ];
  api.now.mockResolvedValue({ rows: [], runs, approvals: [] });
  api.runs.mockResolvedValue({ runs });
  api.thread.mockResolvedValue({
    messages: [
      { id: "external-message", blocks: [{ kind: "text", text: "External task evidence" }] },
    ],
    run: null,
  });
  await renderPage();
  const open = [...node.querySelectorAll('[data-panel="now"] button')].find((button) =>
    button.textContent?.includes("Review external-run"),
  );
  expect(open).toBeDefined();
  await act(async () => (open as HTMLButtonElement).click());
  await vi.waitFor(() =>
    expect(node.querySelector('[role="dialog"]')?.textContent).toContain("External task evidence"),
  );
  expect(api.thread).toHaveBeenCalledWith({ botId: "bot", threadId: "external-thread" });
});
it.each(["needs-sign-in", "not-connected"])(
  "renders integration %s with its reconnect state",
  async (state) => {
    api.connections.mockResolvedValue(
      connectionOverview({
        integrations: {
          catalog: [],
          connections: [{ id: "calendar", catalogId: "Calendar", state }],
        } as unknown as IntegrationCatalogList,
        servers: [{ id: "calendar", name: "Calendar", enabled: true, oauthStatus: "reconnect" }],
        devices: [],
        channels: [],
      }),
    );
    await renderPage();
    expect(node.querySelector('[data-panel="connections"]')?.textContent).toContain(
      "Needs sign-in",
    );
  },
);
it("labels aggregate usage as records rather than provider requests", async () => {
  api.usage.mockResolvedValue({
    ...summary,
    providers: [
      {
        provider: "Aggregate collector",
        today: { ...period, records: 2 },
        week: { ...period, records: 2 },
        daily: [],
      },
    ],
  });
  await renderPage();
  expect(node.querySelector('[data-panel="usage"]')?.textContent).toContain("2 usage records");
  expect(node.querySelector('[data-panel="usage"]')?.textContent).not.toContain("requests");
});

it("shows ready work when filing outcomes fail", async () => {
  api.work.mockResolvedValue({
    workspace: { id: "planning", name: "Planning" },
    ready: 2,
    inProgress: 1,
    blocked: 0,
    items: [{ id: "work-1", title: "Next work" }],
  });
  api.filingOutcomes.mockRejectedValue(new Error("outcomes unavailable"));
  await renderPage();
  const panel = node.querySelector('[data-panel="work"]')!;
  expect(panel.textContent).toContain("Ready: 2");
  expect(panel.textContent).toContain("Next work");
  expect(panel.textContent).not.toContain("Board outcomes");
  expect(panel.textContent).not.toContain("Could not load");
  expect(panel.textContent).not.toContain("closed without being completed");
});

it.each([
  ["missing", []],
  ["malformed", { bots: [{ botId: "bot", name: "Helper", filed: "three" }] }],
  ["empty", null],
])(
  "shows ready work and no counts when the filing outcomes answer is %s",
  async (_label, answer) => {
    api.work.mockResolvedValue({
      workspace: { id: "planning", name: "Planning" },
      ready: 2,
      inProgress: 1,
      blocked: 0,
      items: [{ id: "work-1", title: "Next work" }],
    });
    // The e2e dashboard fixture answers any procedure it does not know with [].
    api.filingOutcomes.mockResolvedValue(answer);
    await renderPage();
    const panel = node.querySelector('[data-panel="work"]')!;
    expect(panel.textContent).toContain("Ready: 2");
    expect(panel.textContent).toContain("Next work");
    expect(panel.textContent).not.toContain("Could not load");
    expect(panel.textContent).not.toContain("closed without being completed");
  },
);

it("shows default-board work and item links without adding subscriptions", async () => {
  api.work.mockResolvedValue({
    workspace: { id: "planning", name: "Planning" },
    ready: 2,
    inProgress: 1,
    blocked: 3,
    items: [{ id: "work-1", title: "Next work" }],
  });
  await renderPage();
  const panel = node.querySelector('[data-panel="work"]')!;
  expect(panel.textContent).toContain("Ready: 2");
  expect(panel.textContent).toContain("In progress: 1");
  expect(panel.textContent).toContain("Blocked: 3");
  expect(panel.querySelector('a[href*="item=work-1"]')?.getAttribute("href")).toBe(
    "/app/board?workspace=planning&item=work-1",
  );
  expect(api.work).toHaveBeenCalledTimes(1);
  expect(api.subscribe).not.toHaveBeenCalled();
});
