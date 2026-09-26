// @vitest-environment jsdom

import { mcpSignInDiagnostic } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const complete = vi.hoisted(() => vi.fn());
const posted = vi.hoisted(() => [] as unknown[]);
vi.mock("../lib/rpc", () => ({ rpc: { mcp: { oauth: { complete } } } }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { McpOAuthCallbackPage } from "./McpOAuthCallback";

let cleanup: () => Promise<void>;
beforeEach(() => {
  vi.clearAllMocks();
  posted.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage(message: unknown) {
        posted.push(message);
      }
      close() {}
    },
  );
  vi.spyOn(window, "close").mockImplementation(() => undefined);
});
afterEach(async () => {
  await cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/mcp/oauth/callback?code=synthetic-code&state=session"]}>
        <McpOAuthCallbackPage />
      </MemoryRouter>,
    );
  });
  return container;
}

it.each([
  ["Could not reach this integration. Try again.", "Could not reach this integration. Try again."],
  [mcpSignInDiagnostic("refresh_unavailable"), "The saved sign-in expired. Sign in again."],
  [mcpSignInDiagnostic("invalid_token"), "The saved sign-in is no longer accepted. Sign in again."],
])("shows a failed discovery as %s instead of Connected", async (lastError, sentence) => {
  complete.mockResolvedValue({ ok: true, result: "failed", lastError });
  const container = await mount();
  expect(container.textContent).toContain("OAuth connection failed");
  expect(container.textContent).toContain(sentence);
  expect(container.textContent).not.toContain("Connected");
  expect(container.textContent).not.toContain("Needs sign-in (");
  expect(window.close).not.toHaveBeenCalled();
  // The opener re-reads the recorded state instead of treating the message as connected.
  expect(posted).toEqual([{ type: "mcp-oauth-complete", sessionId: "session" }]);
});

it("says Connected and closes after a clean completion", async () => {
  complete.mockResolvedValue({ ok: true, result: "connected" });
  const container = await mount();
  expect(container.textContent).toContain("Connected");
  expect(window.close).toHaveBeenCalled();
});

it("says a replaced window was replaced and tells the opener", async () => {
  complete.mockResolvedValue({ ok: true, result: "replaced" });
  const container = await mount();
  expect(container.textContent).toContain(
    "This sign-in window was replaced by a newer one. Finish signing in there, or start again.",
  );
  expect(posted).toEqual([
    { type: "mcp-oauth-complete", sessionId: "session", result: "replaced" },
  ]);
});
