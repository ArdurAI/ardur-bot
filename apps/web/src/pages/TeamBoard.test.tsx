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
const calls = vi.hoisted(() => ({
  cancel: vi.fn(async () => ({ cancelRequested: true })),
  accept: vi.fn(async () => ({ accepted: true })),
}));
vi.mock("../lib/rpc", () => ({ rpc: { delegations: calls } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
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
  ["local-docker", "This Mac", "Docker on this Mac"],
  ["local-docker", "This computer", "Docker on this computer"],
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
