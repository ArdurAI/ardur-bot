// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  data: { user: { id: "user" } } as { user: { id: string } } | null,
  isPending: false,
  error: null,
}));
vi.mock("./lib/auth", () => ({ authClient: { useSession: () => session } }));
vi.mock("./lib/performance", () => ({ markOnce: vi.fn(), markAfterPaint: vi.fn() }));
vi.mock("./lib/preferences", () => ({ resetPreferences: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("./components/PreferencesProvider", () => ({
  PreferencesProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Shell", () => ({
  ShellPage: ({ dashboard, team }: { dashboard?: boolean; team?: boolean }) => (
    <p>{dashboard ? "Dashboard route" : team ? "Team route" : "Bot route"}</p>
  ),
}));
vi.mock("./pages/ide/IdePage", () => ({ default: () => <p>IDE route</p> }));
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/LocalSettings", () => ({ LocalSettingsPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));
vi.mock("./pages/SharedCommand", () => ({
  SharedCommandPage: () => null,
  SharedCommandSignIn: () => null,
}));
vi.mock("./pages/system/QuickComposer", () => ({ QuickComposer: () => null }));
vi.mock("./pages/Auth", () => ({
  AuthPage: () => <p>Sign in route</p>,
  PasswordResetPage: () => null,
}));

import { App } from "./App";

describe("App routing", () => {
  it.each([
    ["/app/board", true, "Dashboard route"],
    ["/app/board?workspace=board&item=work-1", true, "Dashboard route"],
    ["/app?view=board&workspace=board&item=work-1", true, "Dashboard route"],
    ["/app/team", true, "Team route"],
    ["/app/builder", true, "Bot route"],
    ["/app/board", false, "Sign in route"],
    ["/app/team", false, "Sign in route"],
    ["/app/ide", true, "IDE route"],
    ["/app/bot", true, "Bot route"],
    ["/app/ide", false, "Sign in route"],
  ] as const)("routes %s with signed-in=%s", async (url, signedIn, expected) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    session.data = signedIn ? { user: { id: "user" } } : null;
    const host = document.createElement("div"),
      render = createRoot(host);
    window.history.replaceState(null, "", url);
    try {
      await act(async () =>
        render.render(
          <BrowserRouter>
            <App />
          </BrowserRouter>,
        ),
      );
      await vi.waitFor(() => expect(host.textContent).toBe(expected));
    } finally {
      await act(async () => render.unmount());
      vi.unstubAllGlobals();
    }
  });
});
