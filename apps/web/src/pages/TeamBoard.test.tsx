// @vitest-environment jsdom
import type { TeamRow } from "@ardurbot/contracts";
import { TeamRowSchema } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { TeamBoardRow } from "./TeamBoard";

vi.mock("./CompareStart", () => ({
  CompareStart: () => <button type="button">Run on other bots</button>,
}));
vi.mock("./ComparePanel", () => ({ ComparisonList: () => null }));
vi.mock("./PeerMessagesOverlay", () => ({
  PeerMessagesOverlay: ({ onClose, groupId }: { onClose: () => void; groupId?: string }) => (
    <div data-testid="peer-sheet" data-group-id={groupId}>
      <button type="button" onClick={onClose}>
        Close conversation
      </button>
    </div>
  ),
}));
const calls = vi.hoisted(() => ({
  cancel: vi.fn(async () => ({ cancelRequested: true })),
  accept: vi.fn(async () => ({ accepted: true })),
}));
vi.mock("../lib/rpc", () => ({ rpc: { delegations: calls } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (
      parts: TemplateStringsArray | { id: string; values?: Record<string, unknown> },
      ...values: unknown[]
    ) => {
      if ("id" in parts) {
        const bound = parts.values ?? {};
        return parts.id.replace(/\{(\w+)\}/g, (_, key: string) => String(bound[key] ?? `{${key}}`));
      }
      return parts.reduce(
        (text, part, index) => text + part + (index < values.length ? String(values[index]) : ""),
        "",
      );
    },
  }),
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));
const row: TeamRow = TeamRowSchema.parse({
  botId: "worker",
  botName: "Reviewer",
  threadId: "thread",
  cursor: 1,
  state: "completed",
  sentence: "Review sources",
  requesterName: "Chief",
  reason: null,
  action: null,
  rootTaskId: "root",
  delegationId: "handoff",
  canStop: true,
  canAccept: true,
  chain: [
    { id: "chief", name: "Chief", role: "requester" },
    { id: "worker", name: "Reviewer", role: "worker" },
    { id: "chief", name: "Chief", role: "reviewer" },
  ],
  delegations: [],
  executing: null,
  usage: { tokens: 150, costs: [] },
});
it.each([false, true, undefined])(
  "renders the executing effort with evidence %s",
  async (effortAttested) => {
    const node = document.createElement("div");
    const root = createRoot(node);
    const executing = {
      pin: {
        runtimeKind: "claude-code" as const,
        provider: "anthropic",
        modelId: "claude-opus-5",
        effort: "high",
        credentialId: "native:claude-code",
        revision: 1,
      },
      computer: { id: "computer", kind: "desktop", mode: "dedicated" as const },
      destination: { host: null, local: false },
      runtimeInfo: { runtimeKind: "claude-code" as const, effortAttested },
    };
    await act(async () =>
      root.render(
        <MemoryRouter>
          <TeamBoardRow row={{ ...row, executing }} refresh={async () => {}} />
        </MemoryRouter>,
      ),
    );
    expect([...node.querySelectorAll("dd")].map((dd) => dd.textContent)).toContain(
      effortAttested ? "high" : "high · requested",
    );
    expect(node.textContent?.includes("requested")).toBe(effortAttested !== true);
    await act(async () => root.unmount());
  },
);
it.each([
  ["host", "This Mac", "This Mac"],
  ["host", "This computer", "This computer"],
  ["local-docker", "This Mac", "Docker engine on this Mac"],
  ["local-docker", "This computer", "Docker engine on this computer"],
] as const)(
  "translates a built-in computer of kind %s under host label %s",
  async (computerBuiltin, hostLabel, expected) => {
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    await act(async () =>
      root.render(
        <MemoryRouter>
          <TeamBoardRow
            row={{ ...row, computerName: "ignored", computerBuiltin }}
            hostLabel={hostLabel}
            refresh={async () => {}}
          />
        </MemoryRouter>,
      ),
    );
    expect(node.textContent).toContain(expected);
    expect(node.textContent).not.toContain("ignored");
    await act(async () => root.unmount());
    node.remove();
  },
);
it("renders a board row with expansion, quiet completion and distinct native actions", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const refresh = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TeamBoardRow row={row} refresh={refresh} />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("Done — waiting for your OK");
  expect(node.textContent).toContain("Chief → Reviewer → Chief");
  expect(node.querySelector("summary")).toBeTruthy();
  expect(node.querySelector("textarea")).toBeNull();
  expect(node.innerHTML).toContain("motion-reduce:transition-none");
  const button = (text: string) =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === text)!;
  await act(async () => button("Stop").click());
  expect(calls.cancel).toHaveBeenCalledWith({ rootTaskId: "root" });
  await act(async () => button("Accept").click());
  expect(calls.accept).toHaveBeenCalledWith({ id: "handoff" });
  expect(refresh).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  node.remove();
});

it("shows unknown and stale presence honestly, and returns from a peer conversation", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  const current = Date.now();
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TeamBoardRow
          row={{
            ...row,
            state: "idle",
            availability: "unknown",
            observedAt: new Date(current).toISOString(),
            latestPeerBotId: "peer",
            latestPeerBotName: "Worker",
            latestDeliveryState: "read",
            latestDeliveryGroupId: "goal-room",
          }}
          now={current}
          refresh={async () => {}}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("Status unavailable");
  const open = [...node.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Conversation with"),
  );
  await act(async () => open!.click());
  expect(node.querySelector('[data-testid="peer-sheet"]')).toBeTruthy();
  expect(node.querySelector('[data-testid="peer-sheet"]')?.getAttribute("data-group-id")).toBe(
    "goal-room",
  );
  await act(async () =>
    node.querySelector<HTMLButtonElement>('[data-testid="peer-sheet"] button')!.click(),
  );
  expect(node.querySelector('[data-testid="peer-sheet"]')).toBeNull();
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TeamBoardRow
          row={{
            ...row,
            state: "idle",
            availability: "idle",
            observedAt: new Date(current - 61_000).toISOString(),
          }}
          now={current}
          refresh={async () => {}}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("Status unavailable");
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TeamBoardRow
          row={{
            ...row,
            state: "idle",
            availability: "unavailable",
            observedAt: new Date(current).toISOString(),
          }}
          now={current}
          refresh={async () => {}}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("Status unavailable");
  expect(node.textContent).not.toContain("Idle");
  await act(async () => root.unmount());
});

it.each([
  ["working", "Working on Review sources", "for "],
  ["blocked", "Blocked — The task needs attention", "Status unavailable"],
] as const)("keeps %s status readable without a requester", async (state, expected, absent) => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TeamBoardRow
          row={{
            ...row,
            state,
            requesterName: null,
            sentence: null,
            currentTaskTitle: state === "working" ? "Review sources" : undefined,
            reason: state === "blocked" ? "The task needs attention" : null,
            availability: state === "blocked" ? "unavailable" : "busy",
            observedAt: new Date().toISOString(),
          }}
          refresh={async () => {}}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain(expected);
  expect(node.textContent).not.toContain(absent);
  await act(async () => root.unmount());
});

it("shows unavailable usage instead of zero, and a partial total as a lower bound", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TeamBoardRow
          row={{ ...row, usage: { tokens: null, partial: false, costs: [] } }}
          refresh={async () => {}}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("Tokens");
  expect(node.textContent).toContain("Unavailable");
  expect(node.textContent).not.toContain("Tokens: 0");
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TeamBoardRow
          row={{ ...row, usage: { tokens: 40, partial: true, costs: [] } }}
          refresh={async () => {}}
        />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toContain("at least 40");
  await act(async () => root.unmount());
});
