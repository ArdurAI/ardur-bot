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
