// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useParams } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { authReturnPath } from "./lib/auth-return-path";
import { readOpenTo, writeOpenTo } from "./pages/shell/open-to";

let mockSessionUser: { id: string } | null = { id: "viewer" };

vi.mock("./lib/auth", () => ({
  authClient: {
    useSession: () => ({
      data: mockSessionUser ? { user: mockSessionUser } : null,
      isPending: false,
      error: null,
    }),
  },
}));
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./components/PreferencesProvider", () => ({
  PreferencesProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/system/QuickComposer", () => ({ QuickComposer: () => null }));
vi.mock("./pages/Auth", () => ({
  AuthPage: ({ mode }: { mode: string }) => {
    const location = useLocation();
    return (
      <output data-testid="auth-page">{`${mode}:${location.pathname}${location.search}`}</output>
    );
  },
  PasswordResetPage: () => null,
}));
vi.mock("./pages/Onboarding", () => ({
  OnboardingPage: () => <output data-testid="onboarding-page">onboarding</output>,
}));
vi.mock("./pages/ide/IdePage", () => ({ default: () => <output>ide</output> }));
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
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  mockSessionUser = { id: "viewer" };
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

it.each([
  ["/onboarding", "/sign-in?next=%2Fonboarding"],
  ["/mcp/oauth/callback", "/sign-in?next=%2Fmcp%2Foauth%2Fcallback"],
  [
    "/mcp/oauth/callback?code=sample&state=local-state",
    "/sign-in?next=%2Fmcp%2Foauth%2Fcallback%3Fcode%3Dsample%26state%3Dlocal-state",
  ],
  ["/integrations/setup", "/sign-in?next=%2Fintegrations%2Fsetup"],
  ["/integrations/setup?mode=mcp", "/sign-in?next=%2Fintegrations%2Fsetup%3Fmode%3Dmcp"],
  ["/app/board", "/sign-in?next=%2Fapp%2Fboard"],
  ["/app/ide", "/sign-in?next=%2Fapp%2Fide"],
  ["/app/team", "/sign-in?next=%2Fapp%2Fteam"],
  ["/app", "/sign-in?next=%2Fapp"],
  ["/app/bots", "/sign-in?next=%2Fapp%2Fbots"],
  ["/app/g/group-id", "/sign-in?next=%2Fapp%2Fg%2Fgroup-id"],
  ["/app/bot-id", "/sign-in?next=%2Fapp%2Fbot-id"],
])(
  "redirects unauthenticated visit to %s to sign-in with preserved return path",
  async (path, expectedSignIn) => {
    mockSessionUser = null;
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      ),
    );
    expect(node.querySelector('[data-testid="auth-page"]')?.textContent).toBe(
      `in:${expectedSignIn}`,
    );
    expect(
      authReturnPath(new URL(expectedSignIn, "http://localhost").searchParams.get("next")),
    ).toBe(path);
  },
);
