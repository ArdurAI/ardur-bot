// @vitest-environment jsdom
import type { WorkspaceContext, WorkspaceGit } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GitChangesScreen from "../app/git-changes";
import { rpc } from "./api";
import { RpcServerError } from "./rpc-error";

const fakes = vi.hoisted(() => ({ params: { botId: "bot" } as { botId?: string }, paired: false }));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./dispatch", () => ({ hasPairedDevice: async () => fakes.paired }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({
    background: "white",
    foreground: "black",
    mutedForeground: "gray",
    destructive: "red",
    success: "green",
    border: "silver",
  }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (message: string) => message }) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => fakes.params,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => h("div", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => h("div", null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) =>
    h("span", { role: accessibilityRole }, children),
  ActivityIndicator: () => h("span", null, "Loading"),
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    h("button", { type: "button", onClick: onPress }, title),
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) =>
    h("button", { type: "button", onClick: onPress }, children),
  SectionList: ({
    sections,
    renderItem,
    renderSectionHeader,
    ListEmptyComponent,
  }: {
    sections: Array<{ title: string; data: Array<{ path: string }>; kind: string }>;
    renderItem: (info: { item: { path: string }; section: { title: string } }) => ReactNode;
    renderSectionHeader: (info: { section: { title: string; data: unknown[] } }) => ReactNode;
    ListEmptyComponent: ReactNode;
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
    ),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

const context: WorkspaceContext = {
  botId: "bot",
  computerId: "computer",
  rootId: "root",
  generation: 2,
  files: "live",
  git: true,
  observedAt: "2026-10-14T00:00:00.000Z",
};
const changed = () => new RpcServerError("Computer changed. Refresh files.", "CONFLICT");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let describeCount: number;
let gitGeneration: number | null;
const tick = async () => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
};
async function show() {
  await act(async () => root.render(h(GitChangesScreen)));
  await tick();
  await tick();
}
function button(name: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === name);
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fakes.params = { botId: "bot" };
  fakes.paired = false;
  describeCount = 0;
  gitGeneration = 2;
  vi.mocked(rpc)
    .mockReset()
    .mockImplementation(async (name, input) => {
      if (name === "workspace/describe") {
        describeCount += 1;
        return { ...context, generation: describeCount === 1 ? 2 : 3 };
      }
      if (name === "workspace/git") {
        const request = input as { generation: number; path?: string };
        gitGeneration = request.generation;
        if (request.generation === 1) throw changed();
        return {
          context: { ...context, generation: request.generation },
          status: "ok",
          entries: request.path
            ? undefined
            : [
                {
                  path: "app.ts",
                  staged: false,
                  unstaged: true,
                  untracked: false,
                  conflict: false,
                  change: "modified",
                },
              ],
          truncated: false,
          ...(request.path
            ? {
                diff: {
                  path: request.path,
                  before: "old",
                  after: "new",
                  binary: false,
                  truncated: false,
                },
              }
            : {}),
        } satisfies Partial<WorkspaceGit>;
      }
      throw new Error(`Unexpected procedure ${name}`);
    });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("lists live Git changes for the described generation", async () => {
  await show();
  expect(host.textContent).toContain("Modified 1");
  expect(host.textContent).toContain("app.ts");
  expect(gitGeneration).toBe(2);
  await act(async () => button("app.ts").click());
  await tick();
  expect(host.textContent).toContain("- old");
  expect(host.textContent).toContain("+ new");
});

it("shows the same unavailable sentence when the computer cannot serve Git", async () => {
  vi.mocked(rpc).mockImplementation(async (name) => {
    if (name === "workspace/describe") return { ...context, git: false };
    throw new Error(`Unexpected procedure ${name}`);
  });
  await show();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Git changes are unavailable on this computer.",
  );
  expect(vi.mocked(rpc)).not.toHaveBeenCalledWith("workspace/git", expect.anything());
});

it("does not call Git for a paired device", async () => {
  fakes.paired = true;
  await show();
  expect(host.textContent).toContain("Sign in to browse files.");
  expect(rpc).not.toHaveBeenCalled();
});

it("ignores a stale list after refresh", async () => {
  let resolveStale: ((value: unknown) => void) | undefined;
  let gitCalls = 0;
  vi.mocked(rpc).mockImplementation(async (name) => {
    if (name === "workspace/describe") return context;
    if (name === "workspace/git") {
      gitCalls += 1;
      if (gitCalls === 1) {
        return new Promise((done) => {
          resolveStale = done;
        });
      }
      return { context, status: "ok", entries: [], truncated: false };
    }
    throw new Error(`Unexpected procedure ${name}`);
  });
  await show();
  expect(host.textContent).toContain("Loading");
  await act(async () => button("Refresh").click());
  await tick();
  await tick();
  expect(host.textContent).toContain("No changes to show");
  await act(async () =>
    resolveStale?.({
      context,
      status: "ok",
      entries: [
        {
          path: "stale.ts",
          staged: true,
          unstaged: false,
          untracked: false,
          conflict: false,
          change: "added",
        },
      ],
      truncated: false,
    }),
  );
  await tick();
  expect(host.textContent).toContain("No changes to show");
  expect(host.textContent).not.toContain("stale.ts");
});

it("retries a conflict once with the new generation", async () => {
  const generations: number[] = [];
  vi.mocked(rpc).mockImplementation(async (name, input) => {
    if (name === "workspace/describe") {
      describeCount += 1;
      return { ...context, generation: describeCount === 1 ? 2 : 4 };
    }
    if (name === "workspace/git") {
      const request = input as { generation: number };
      generations.push(request.generation);
      if (request.generation === 2) throw changed();
      return {
        context: { ...context, generation: request.generation },
        status: "ok",
        entries: [],
        truncated: false,
      };
    }
    throw new Error(`Unexpected procedure ${name}`);
  });
  await show();
  expect(generations).toEqual([2, 4]);
  expect(host.textContent).toContain("No changes to show");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
