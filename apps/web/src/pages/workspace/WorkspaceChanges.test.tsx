// @vitest-environment jsdom
import type { WorkspaceContext } from "@ardurbot/contracts";
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceChanges } from "./WorkspaceChanges";

const read = vi.hoisted(() => vi.fn());
vi.mock("./change-target", () => ({ readWorkspaceChange: read }));
vi.mock("../ide/changes", () => ({
  useChanges: () => ({ items: [], more: undefined }),
  Changes: () => <div data-history />,
}));
vi.mock("../ide/diff", () => ({
  default: ({ change }: { change: { path: string } }) => <div data-diff>{change.path}</div>,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
const context: WorkspaceContext = {
  botId: "bot",
  rootId: "root",
  computerId: "computer",
  generation: 1,
  files: "live",
  observedAt: "2026-10-01T00:00:00Z",
};
const location = {
  changeId: "record",
  since: "2026-10-01T00:00:00Z",
  until: "2026-10-02T00:00:00Z",
  requestId: 1,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  read.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("clears a cancelled location's loading state and ignores its late diff", async () => {
  let resolve!: (value: unknown) => void;
  read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () =>
    root.render(<WorkspaceChanges context={context} visible location={location} />),
  );
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const signal = read.mock.calls[0]![2] as AbortSignal;
  await act(async () => root.render(<WorkspaceChanges context={context} visible />));
  expect(signal.aborted).toBe(true);
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector("[data-history]")).not.toBeNull();
  await act(async () => resolve({ path: "stale.md" }));
  expect(host.querySelector("[data-diff]")).toBeNull();
});
it("refuses a failed checked target without showing its old diff", async () => {
  read.mockRejectedValue(new Error("Resource not found"));
  await act(async () =>
    root.render(<WorkspaceChanges context={context} visible location={location} />),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not open file");
  expect(host.querySelector("[data-diff]")).toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
});
