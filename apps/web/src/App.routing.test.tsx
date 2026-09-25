// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useParams } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { readOpenTo, writeOpenTo } from "./pages/shell/open-to";

vi.mock("./lib/auth", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "viewer" } }, isPending: false, error: null }),
  },
}));
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./components/PreferencesProvider", () => ({
  PreferencesProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/system/QuickComposer", () => ({ QuickComposer: () => null }));
vi.mock("./pages/Shell", () => ({
  ShellPage: ({
    dashboard,
    team,
    board,
  }: {
    dashboard?: boolean;
    team?: boolean;
    board?: boolean;
  }) => {
    const params = useParams();
    return (
      <output>
        {dashboard
          ? "dashboard"
          : team
            ? "team"
            : board
              ? "board"
              : `bots:${params.botId ?? params.groupId ?? "list"}`}
      </output>
    );
  },
}));
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/LocalSettings", () => ({ LocalSettingsPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));
vi.mock("./pages/SharedCommand", () => ({
  SharedCommandPage: () => null,
  SharedCommandSignIn: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
  });
  node = document.createElement("div");
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  ["/app", "dashboard"],
  ["/app/board?workspace=board&item=item-1", "dashboard"],
  ["/app?view=board", "dashboard"],
  ["/app/bots", "bots:list"],
  ["/app/bot-id?m=message", "bots:bot-id"],
  ["/app/g/group-id", "bots:group-id"],
  ["/app/team", "team"],
  ["/app/board", "dashboard"],
])("preserves %s", async (path, expected) => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path!]}>
        <App />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toBe(expected);
});
it("honors the local Open to setting, while explicit Dashboard navigation still works", async () => {
  expect(readOpenTo()).toBe("dashboard");
  writeOpenTo("bots");
  expect(readOpenTo()).toBe("bots");
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/app"]}>
        <App />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toBe("bots:list");
  await act(async () =>
    root.render(
      <MemoryRouter key="explicit" initialEntries={["/app?view=dashboard"]}>
        <App />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toBe("dashboard");
  writeOpenTo("dashboard");
});
it("defaults malformed preferences to Dashboard and does not use an account identifier", () => {
  localStorage.setItem("ardurbot:open-to", "other");
  expect(readOpenTo()).toBe("dashboard");
  writeOpenTo("bots");
  expect(localStorage.length).toBe(1);
  writeOpenTo("dashboard");
});
