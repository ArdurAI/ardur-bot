// @vitest-environment jsdom
import type { WorkspaceContext } from "@ardurbot/contracts";
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceGitChanges } from "./WorkspaceGitChanges";

const git = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { workspace: { git } } }));
vi.mock("../ide/diff", () => ({
  default: ({ change }: { change: { before: string | null; after: string | null } }) => (
    <div data-diff>
      {change.before ?? "∅"}→{change.after ?? "∅"}
    </div>
  ),
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
  git: true,
  observedAt: "2026-10-01T00:00:00Z",
};
const status = {
  context,
  status: "ok",
  head: "a".repeat(40),
  entries: [
    { path: "staged.md", staged: true, unstaged: false, untracked: false, conflict: false },
    { path: "dirty.md", staged: false, unstaged: true, untracked: false, conflict: false },
    { path: "new.md", staged: false, unstaged: false, untracked: true, conflict: false },
  ],
  truncated: false,
} as const;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  git.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("lists staged, unstaged and untracked groups and opens a diff", async () => {
  git.mockImplementation(async (input: { path?: string }) =>
    input.path === "staged.md"
      ? {
          context,
          status: "ok",
          diff: { path: "staged.md", before: "old", after: "new", binary: false, truncated: false },
        }
      : status,
  );
  await act(async () => root.render(<WorkspaceGitChanges context={context} visible />));
  expect(git).toHaveBeenCalledWith(
    { botId: "bot", rootId: "root", computerId: "computer", generation: 1 },
    expect.anything(),
  );
  expect(host.textContent).toContain("Staged");
  expect(host.textContent).toContain("Unstaged");
  expect(host.textContent).toContain("Untracked");
  expect(host.querySelector('[data-workspace-git] [role="status"]')).toBeNull();
  await act(async () => {
    host
      .querySelectorAll("button")
      .item(1) // first group entry: staged.md
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(host.textContent).toContain("old→new");
  expect(host.querySelector("[data-diff]")).not.toBeNull();
  // Back to the list, then refresh again.
  await act(async () => {
    host
      .querySelectorAll("button")
      .item(0)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(host.querySelector("[data-diff]")).toBeNull();
  const calls = git.mock.calls.length;
  await act(async () => {
    host
      .querySelectorAll("button")
      .item(1) // Refresh
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(git.mock.calls.length).toBeGreaterThan(calls);
});
it("shows not-repository, unavailable, binary and too-large states", async () => {
  git.mockResolvedValue({ context, status: "not-repository" });
  await act(async () => root.render(<WorkspaceGitChanges key="a" context={context} visible />));
  expect(host.textContent).toContain("Not a Git repository");

  git.mockResolvedValue({ context, status: "unavailable" });
  await act(async () => root.render(<WorkspaceGitChanges key="b" context={context} visible />));
  expect(host.querySelector('[data-workspace-git] [role="alert"]')?.textContent).toContain(
    "Git changes are unavailable on this computer.",
  );

  git.mockImplementation(async (input: { path?: string }) =>
    input.path === "bin.dat"
      ? {
          context,
          status: "ok",
          diff: { path: "bin.dat", before: "", after: "", binary: true, truncated: false },
        }
      : {
          ...status,
          entries: [
            { path: "bin.dat", staged: false, unstaged: true, untracked: false, conflict: false },
          ],
        },
  );
  await act(async () => root.render(<WorkspaceGitChanges context={context} visible />));
  await act(async () => {
    host
      .querySelectorAll("button")
      .item(1)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(host.textContent).toContain("Binary file");
  expect(host.querySelector("[data-diff]")).toBeNull();

  git.mockImplementation(async (input: { path?: string }) =>
    input.path === "big.md"
      ? {
          context,
          status: "ok",
          diff: { path: "big.md", before: "x", after: "y", binary: false, truncated: true },
        }
      : {
          ...status,
          entries: [
            { path: "big.md", staged: false, unstaged: true, untracked: false, conflict: false },
          ],
        },
  );
  await act(async () => root.render(<WorkspaceGitChanges key="c" context={context} visible />));
  await act(async () => {
    host
      .querySelectorAll("button")
      .item(1)
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(host.textContent).toContain("Diff is too large");
  expect(host.querySelector("[data-diff]")).not.toBeNull();
});
it("ignores a stale list response after refresh", async () => {
  let resolveStale!: (value: unknown) => void;
  git.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolveStale = done;
      }),
  );
  git.mockResolvedValue({ ...status, entries: [] });
  await act(async () => root.render(<WorkspaceGitChanges context={context} visible />));
  expect(host.querySelector('[data-workspace-git] [role="status"]')).not.toBeNull();
  await act(async () => {
    host
      .querySelectorAll("button")
      .item(0) // Refresh aborts the stale request
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => resolveStale({ context, status: "ok", entries: [], truncated: false }));
  expect(host.textContent).toContain("No changes to show");
  expect(host.textContent).not.toContain("staged.md");
});
