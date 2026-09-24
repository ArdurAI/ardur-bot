// @vitest-environment jsdom
import type { DelegationRecord } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DelegationLines } from "./DelegationLines";

const cancel = vi.hoisted(() => vi.fn(async () => ({ cancelRequested: true })));
vi.mock("../lib/rpc", () => ({ rpc: { delegations: { cancel } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));
it("shows lineage and requests stop for the root without claiming it is cancelled", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const rows = [
    { id: "handoff", requesterName: "Chief", actingName: "Reviewer", status: "running" },
  ] as DelegationRecord[];
  await act(async () => root.render(<DelegationLines rootTaskId="root-task" rows={rows} />));
  expect(node.textContent).toContain("Chief → Reviewer · Running");
  await act(async () => node.querySelector("button")!.click());
  expect(cancel).toHaveBeenCalledWith({ rootTaskId: "root-task" });
  expect(node.textContent).toContain("Stopping");
  expect(node.textContent).not.toContain("Cancelled");
  await act(async () => root.unmount());
  node.remove();
});
