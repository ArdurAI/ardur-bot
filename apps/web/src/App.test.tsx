// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./lib/auth", () => ({
  authClient: { useSession: () => ({ isPending: false, data: { user: { id: "owner" } } }) },
}));
vi.mock("./lib/performance", () => ({ markOnce: vi.fn(), markAfterPaint: vi.fn() }));
vi.mock("./pages/Shell", () => ({
  ShellPage: ({ board, team }: { board?: boolean; team?: boolean }) => (
    <div>{board ? "project-board" : team ? "team-board" : "chat"}</div>
  ),
}));
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/LocalSettings", () => ({ LocalSettingsPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));
vi.mock("./pages/SharedCommand", () => ({
  SharedCommandPage: () => null,
  SharedCommandSignIn: () => null,
}));
vi.mock("@ardurbot/ui-web", () => ({ Button: () => null }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
it.each([
  ["/app/board", "project-board"],
  ["/app/team", "team-board"],
  ["/app/builder", "chat"],
])("routes %s independently", async (route, expected) => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    ),
  );
  expect(node.textContent).toBe(expected);
  await act(async () => root.unmount());
});
