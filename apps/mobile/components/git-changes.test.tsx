// @vitest-environment jsdom
import type { GitStatusEntry } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitChangesDiff, GitChangesList } from "./git-changes";

vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (message: string) => message }) }));
vi.mock("../lib/native", () => ({
  useMobileTokens: () => ({
    background: "white",
    foreground: "black",
    mutedForeground: "gray",
    destructive: "red",
    success: "green",
    border: "silver",
  }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => h("div", null, children),
  Text: ({
    children,
    accessibilityRole,
    style,
  }: {
    children: ReactNode;
    accessibilityRole?: string;
    style?: { fontFamily?: string } | Array<{ fontFamily?: string } | undefined>;
  }) => {
    const font = (Array.isArray(style) ? style : [style]).find(
      (item) => item?.fontFamily,
    )?.fontFamily;
    return h("span", { role: accessibilityRole, "data-font": font }, children);
  },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
  }) =>
    h("button", { type: "button", "aria-label": accessibilityLabel, onClick: onPress }, children),
  SectionList: ({
    sections,
    renderItem,
    renderSectionHeader,
    ListEmptyComponent,
    ListFooterComponent,
  }: {
    sections: Array<{ title: string; data: GitStatusEntry[]; kind: string }>;
    renderItem: (info: { item: GitStatusEntry; section: { title: string } }) => ReactNode;
    renderSectionHeader: (info: {
      section: { title: string; data: GitStatusEntry[] };
    }) => ReactNode;
    ListEmptyComponent: ReactNode;
    ListFooterComponent: ReactNode;
  }) =>
    h(
      "div",
      null,
      sections.length
        ? sections.map((section) =>
            h(
              "section",
              { key: section.kind },
              renderSectionHeader({ section }),
              section.data.map((item) => renderItem({ item, section })),
            ),
          )
        : ListEmptyComponent,
      ListFooterComponent,
    ),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

const entry = (path: string, change: GitStatusEntry["change"]): GitStatusEntry => ({
  path,
  staged: change !== "untracked",
  unstaged: change === "modified",
  untracked: change === "untracked",
  conflict: false,
  change,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("lists each status with a count and opens the path", async () => {
  const opened: string[] = [];
  await act(async () =>
    root.render(
      h(GitChangesList, {
        entries: [
          entry("new.ts", "added"),
          entry("app.ts", "modified"),
          entry("old.ts", "deleted"),
          entry("moved.ts", "renamed"),
          entry("note.ts", "untracked"),
        ],
        onOpen: (path) => opened.push(path),
      }),
    ),
  );
  expect(host.textContent).toContain("Added 1");
  expect(host.textContent).toContain("Modified 1");
  expect(host.textContent).toContain("Deleted 1");
  expect(host.textContent).toContain("Renamed 1");
  expect(host.textContent).toContain("Untracked 1");
  await act(async () => {
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "moved.ts")!
      .click();
  });
  expect(opened).toEqual(["moved.ts"]);
});

it("shows no changes when the worktree is clean", async () => {
  await act(async () => root.render(h(GitChangesList, { entries: [], onOpen: () => undefined })));
  expect(host.textContent).toContain("No changes to show");
});

it("shows a bounded text diff with prefixes, not color alone", async () => {
  await act(async () =>
    root.render(
      h(GitChangesDiff, {
        path: "app.ts",
        state: "ready",
        diff: { before: "old", after: "new", binary: false, truncated: false },
      }),
    ),
  );
  expect(host.textContent).toContain("- old");
  expect(host.textContent).toContain("+ new");
  expect(host.querySelector("[data-font='monospace']")).not.toBeNull();
});

it("withholds binary, oversized and secret-looking diffs", async () => {
  await act(async () =>
    root.render(
      h(GitChangesDiff, {
        path: "image.bin",
        state: "ready",
        diff: { before: "secret-bytes", after: "secret-bytes", binary: true, truncated: false },
      }),
    ),
  );
  expect(host.textContent).toContain("Binary file");
  expect(host.textContent).not.toContain("secret-bytes");

  await act(async () =>
    root.render(
      h(GitChangesDiff, {
        key: "big",
        path: "big.md",
        state: "ready",
        diff: { before: "hidden-before", after: "hidden-after", binary: false, truncated: true },
      }),
    ),
  );
  expect(host.textContent).toContain("Diff is too large");
  expect(host.textContent).not.toContain("hidden-before");
  expect(host.textContent).not.toContain("hidden-after");

  await act(async () =>
    root.render(
      h(GitChangesDiff, {
        key: "secret",
        path: "env",
        state: "ready",
        diff: {
          before: "TOKEN=[Redacted]",
          after: "TOKEN=[Redacted]",
          binary: false,
          truncated: false,
        },
      }),
    ),
  );
  expect(host.textContent).toContain("This file looks like it contains a secret.");
  expect(host.textContent).not.toContain("TOKEN=");
  expect(host.textContent).not.toContain("[Redacted]");
});
