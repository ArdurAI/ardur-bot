// @vitest-environment jsdom

import { mcpSignInDiagnostic } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  approve: vi.fn(),
  list: vi.fn(),
  oauth: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    mcp: { servers: { list: api.list }, assignments: { approve: api.approve } },
  },
}));
vi.mock("../../lib/mcp-connect", () => ({ connectMcpOauth: api.oauth }));
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

import { McpApprovalCard } from "./message-cards";

let cleanup: () => Promise<void>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([]);
  api.approve.mockResolvedValue({ id: "assignment" });
});
afterEach(async () => {
  await cleanup?.();
  vi.unstubAllGlobals();
});

async function mount(onOpenMcp?: (serverId: string) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () =>
    root.render(
      <McpApprovalCard
        botId="bot"
        name="Reports"
        serverId="server-1"
        transport="streamable_http"
        endpoint="https://tools.example.test/mcp"
        needsOAuth
        onOpenMcp={onOpenMcp}
      />,
    ),
  );
  return container;
}

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

it("shows the plain sentence when the server offers no browser sign-in", async () => {
  const provider = "provider-denied-browser-sign-in";
  api.oauth.mockImplementation(async () => {
    api.list.mockResolvedValue([
      {
        id: "server-1",
        connectionState: "needs-sign-in",
        lastError: "Needs sign-in (oauth_unavailable).",
      },
    ]);
    throw new Error(provider);
  });
  const container = await mount();
  await click("Authorize");
  expect(container.textContent).toContain(
    "This server did not offer browser sign-in. Enter a token instead.",
  );
  expect(container.textContent).not.toContain(provider);
  expect(api.approve).not.toHaveBeenCalled();
});

it("links a no-browser-sign-in server to where its credential can be fixed", async () => {
  api.oauth.mockImplementation(async () => {
    api.list.mockResolvedValue([
      {
        id: "server-1",
        connectionState: "needs-sign-in",
        lastError: "Needs sign-in (oauth_unavailable).",
      },
    ]);
    throw new Error("provider-denied-browser-sign-in");
  });
  const onOpenMcp = vi.fn();
  const container = await mount(onOpenMcp);
  await click("Authorize");
  await click("Manage");
  expect(onOpenMcp).toHaveBeenCalledExactlyOnceWith("server-1");
  expect(container.textContent).toContain(
    "This server did not offer browser sign-in. Enter a token instead.",
  );
});

it("stops polling for this card's sign-in when the card unmounts", async () => {
  let capturedSignal: AbortSignal | undefined;
  api.oauth.mockImplementation(
    (_serverId: string, options: { signal?: AbortSignal }) =>
      new Promise(() => {
        capturedSignal = options.signal;
      }),
  );
  await mount();
  await click("Authorize");
  expect(capturedSignal).toBeDefined();
  expect(capturedSignal?.aborted).toBe(false);
  await cleanup();
  expect(capturedSignal?.aborted).toBe(true);
});

it("does not offer Manage for a sign-in that just needs another try", async () => {
  api.oauth.mockResolvedValue("needs-sign-in");
  const onOpenMcp = vi.fn();
  const container = await mount(onOpenMcp);
  await click("Authorize");
  expect(container.textContent).toContain("Sign-in did not finish. Try again.");
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain(
    "Manage",
  );
});

it("offers Manage for a disabled server, since enabling it needs MCP settings", async () => {
  api.oauth.mockResolvedValue("disabled");
  const onOpenMcp = vi.fn();
  const container = await mount(onOpenMcp);
  await click("Authorize");
  expect(container.textContent).toContain("Enable this server first, then sign in.");
  await click("Manage");
  expect(onOpenMcp).toHaveBeenCalledExactlyOnceWith("server-1");
});

it("does not approve a bot when tool discovery failed", async () => {
  api.oauth.mockResolvedValue("sign-in-failed");
  api.list.mockResolvedValue([
    {
      id: "server-1",
      connectionState: "discovery-failed",
      lastError: "Could not complete sign-in. Connect again.",
    },
  ]);
  const container = await mount();
  await click("Authorize");
  expect(api.approve).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Could not complete sign-in. Connect again.");
  expect(container.textContent).not.toContain("Connected. Review tools in MCP settings.");
});

it.each([
  ["refresh_unavailable", "The saved sign-in expired. Sign in again."],
  ["invalid_token", "The saved sign-in is no longer accepted. Sign in again."],
])("shows %s as a sentence, never its diagnostic code", async (code, sentence) => {
  api.oauth.mockResolvedValue("sign-in-failed");
  api.list.mockResolvedValue([
    { id: "server-1", connectionState: "needs-sign-in", lastError: mcpSignInDiagnostic(code) },
  ]);
  const container = await mount();
  await click("Authorize");
  expect(api.approve).not.toHaveBeenCalled();
  expect(container.textContent).toContain(sentence);
  expect(container.textContent).not.toContain(code);
});

it.each(["authorization_not_requested", "already_connected"])(
  "approves the bot when the server answers %s",
  async (result) => {
    api.oauth.mockResolvedValue(result);
    const container = await mount();
    await click("Authorize");
    expect(api.approve).toHaveBeenCalledExactlyOnceWith({ botId: "bot", serverId: "server-1" });
    expect(container.textContent).toContain("Connected. Review tools in MCP settings.");
  },
);

it("says a replaced sign-in window was replaced and does not approve the bot", async () => {
  api.oauth.mockResolvedValue("replaced");
  const container = await mount();
  await click("Authorize");
  expect(api.approve).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    "This sign-in window was replaced by a newer one. Finish signing in there, or start again.",
  );
});

it("says sign-in was declined and does not approve the bot", async () => {
  api.oauth.mockResolvedValue("cancelled");
  const container = await mount();
  await click("Authorize");
  expect(api.approve).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Sign-in was declined.");
  expect(container.textContent).not.toContain("Connected. Review tools in MCP settings.");
});
