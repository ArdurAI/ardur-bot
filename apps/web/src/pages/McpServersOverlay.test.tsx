// @vitest-environment jsdom
import type { McpServer } from "@ardurbot/contracts";
import { mcpSignInDiagnostic } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  tools: vi.fn(),
  update: vi.fn(),
}));
const oauth = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({
  rpc: {
    mcp: { servers: fake, assignments: { all: async () => [] } },
    bots: { list: async () => [] },
  },
}));
vi.mock("../lib/mcp-connect", () => ({
  MCP_OAUTH_CHANNEL: "ardurbot-mcp-oauth",
  connectMcpOauth: oauth,
}));
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

import { McpServersOverlay } from "./McpServersOverlay";

let cleanup: () => Promise<void>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null;
      close() {}
    },
  );
  fake.list.mockResolvedValue([]);
});
afterEach(async () => {
  await cleanup?.();
  vi.unstubAllGlobals();
});
async function mount(
  onBusyChange?: (busy: boolean) => void,
  focus?: { serverId: string; request: number },
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () =>
    root.render(
      <McpServersOverlay
        embedded
        onClose={vi.fn()}
        onBusyChange={onBusyChange}
        focusServerId={focus?.serverId}
        focusRequest={focus?.request}
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
async function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("reveals the add form on demand, creates a server and returns to management", async () => {
  const container = await mount();
  expect(container.textContent).toContain("Manage MCP servers");
  expect(container.textContent).toContain("No MCP servers yet.");
  expect(container.querySelector("#mcp-name")).toBeNull();
  await click("Add MCP server");
  await fill("mcp-name", "Reports");
  await fill("mcp-endpoint", "https://tools.example.test/mcp");
  const server = {
    id: "reports",
    name: "Reports",
    transport: "streamable_http",
    oauthStatus: "none",
    endpoint: "https://tools.example.test/mcp",
  } as McpServer;
  fake.create.mockResolvedValue(server);
  fake.list.mockResolvedValue([server]);
  await click("Add server");
  expect(fake.create).toHaveBeenCalledWith({
    slug: "reports",
    name: "Reports",
    transport: "streamable_http",
    endpoint: "https://tools.example.test/mcp",
    headers: {},
    secret: undefined,
    enabled: true,
  });
  expect(container.querySelector("#mcp-name")).toBeNull();
  expect(container.textContent).toContain("Reports");
  await click("Delete");
  expect(fake.remove).not.toHaveBeenCalled();
  fake.list.mockResolvedValue([]);
  await click("Confirm delete");
  expect(fake.remove).toHaveBeenCalledWith({ id: "reports" });
  expect(container.textContent).toContain("No MCP servers yet.");
});

it("keeps a failed add editable and lets the user cancel without creating a server", async () => {
  const container = await mount();
  await click("Add MCP server");
  await click("Add server");
  expect(container.textContent).toContain("Add a server name.");
  expect(fake.create).not.toHaveBeenCalled();
  await fill("mcp-name", "Reports");
  await fill("mcp-endpoint", "https://tools.example.test/mcp");
  fake.create.mockRejectedValue(new Error("Offline"));
  await click("Add server");
  expect(container.querySelector<HTMLInputElement>("#mcp-name")?.value).toBe("Reports");
  expect(container.textContent).toContain("Offline");
  await click("Cancel");
  expect(container.querySelector("#mcp-name")).toBeNull();
  expect(fake.create).toHaveBeenCalledOnce();
});

it("focuses a managed server once and does not scroll again when the list refreshes", async () => {
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  const channels: Array<{ onmessage: ((event: MessageEvent) => void) | null }> = [];
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        channels.push(this);
      }
      close() {}
    },
  );
  const server = {
    id: "reports",
    name: "Reports",
    transport: "streamable_http",
    oauthStatus: "none",
    connectionState: "not-connected",
    endpoint: "https://tools.example.test/mcp",
    enabled: true,
    catalogId: null,
  } as McpServer;
  fake.list.mockResolvedValue([server]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () =>
    root.render(
      <McpServersOverlay embedded onClose={vi.fn()} focusServerId="reports" focusRequest={1} />,
    ),
  );
  expect(document.activeElement?.id).toBe("mcp-server-reports");
  expect(scroll).toHaveBeenCalledTimes(1);
  scroll.mockClear();
  fake.list.mockResolvedValue([{ ...server, name: "Reports refreshed" }]);
  await act(async () => {
    channels.at(-1)?.onmessage?.({ data: { type: "mcp-oauth-complete" } } as MessageEvent);
  });
  expect(container.textContent).toContain("Reports refreshed");
  expect(scroll).not.toHaveBeenCalled();
  expect(document.activeElement?.id).toBe("mcp-server-reports");
});

it("shows the plain sentence when the server offers no browser sign-in", async () => {
  const provider = "provider-denied-browser-sign-in";
  const server = {
    id: "reports",
    name: "Reports",
    transport: "streamable_http",
    oauthStatus: "none",
    connectionState: "not-connected",
    endpoint: "https://tools.example.test/mcp",
    enabled: true,
    catalogId: null,
    lastError: null,
  } as McpServer;
  fake.list.mockResolvedValue([server]);
  oauth.mockImplementation(async () => {
    fake.list.mockResolvedValue([
      {
        ...server,
        connectionState: "needs-sign-in",
        lastError: mcpSignInDiagnostic("oauth_unavailable"),
      },
    ]);
    throw new Error(provider);
  });
  const container = await mount();
  await click("Connect OAuth");
  expect(container.textContent).toContain(
    "This server did not offer browser sign-in. Enter a token instead.",
  );
  expect(container.textContent).not.toContain(provider);
});

it("rejects Add server when a token and a header are both filled", async () => {
  const container = await mount();
  await click("Add MCP server");
  await fill("mcp-name", "Reports");
  await fill("mcp-endpoint", "https://tools.example.test/mcp");
  await fill("mcp-secret", "synthetic-token");
  const header = document.querySelector('[aria-label="Header value"]') as HTMLInputElement;
  expect(header).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      header,
      "synthetic-header",
    );
    header.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Add server");
  expect(fake.create).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Choose one credential: a token or a header.");
});

it("shows a recorded discovery failure instead of a connected label", async () => {
  const server = {
    id: "reports",
    name: "Reports",
    transport: "streamable_http",
    oauthStatus: "none",
    connectionState: "not-connected",
    endpoint: "https://tools.example.test/mcp",
    enabled: true,
    catalogId: null,
    lastError: null,
  } as McpServer;
  fake.list.mockResolvedValue([server]);
  oauth.mockImplementation(async () => {
    fake.list.mockResolvedValue([
      {
        ...server,
        oauthStatus: "connected",
        connectionState: "discovery-failed",
        lastError: "Could not reach this integration. Try again.",
      },
    ]);
    return "sign-in-failed";
  });
  const container = await mount();
  await click("Connect OAuth");
  expect(container.textContent).toContain("Could not reach this integration. Try again.");
  expect(container.textContent).not.toContain("OAuth connected");
});

it("shows an expired sign-in as a sentence, never its diagnostic code", async () => {
  const server = {
    id: "reports",
    name: "Reports",
    transport: "streamable_http",
    oauthStatus: "connected",
    connectionState: "connected",
    endpoint: "https://tools.example.test/mcp",
    enabled: true,
    catalogId: null,
    lastError: null,
  } as McpServer;
  fake.list.mockResolvedValue([server]);
  oauth.mockImplementation(async () => {
    fake.list.mockResolvedValue([
      {
        ...server,
        oauthStatus: "reconnect",
        connectionState: "needs-sign-in",
        lastError: mcpSignInDiagnostic("refresh_unavailable"),
      },
    ]);
    return "sign-in-failed";
  });
  const container = await mount();
  await click("Reconnect OAuth");
  expect(container.textContent).toContain("The saved sign-in expired. Sign in again.");
  expect(container.textContent).not.toContain("refresh_unavailable");
});

const unchecked = {
  id: "reports",
  name: "Reports",
  transport: "streamable_http",
  oauthStatus: "none",
  connectionState: "not-connected",
  endpoint: "https://tools.example.test/mcp",
  enabled: true,
  catalogId: null,
  lastError: null,
} as McpServer;

it("says a replaced sign-in window was replaced", async () => {
  fake.list.mockResolvedValue([unchecked]);
  oauth.mockResolvedValue("replaced");
  const container = await mount();
  await click("Connect OAuth");
  expect(container.textContent).toContain(
    "This sign-in window was replaced by a newer one. Finish signing in there, or start again.",
  );
});

it("says to enable a disabled server first, instead of a replaced sign-in window", async () => {
  fake.list.mockResolvedValue([{ ...unchecked, enabled: false }]);
  oauth.mockResolvedValue("disabled");
  const container = await mount();
  await click("Connect OAuth");
  expect(container.textContent).toContain("Enable this server first, then sign in.");
  expect(container.textContent).not.toContain("was replaced by a newer one");
});

it("stays busy with Cancel while sign-in waits, and stops waiting when the page closes", async () => {
  fake.list.mockResolvedValue([unchecked]);
  let signal: AbortSignal | undefined;
  oauth.mockImplementation(
    (
      _serverId: string,
      options: {
        signal?: AbortSignal;
        onWaiting?: (waiting: { sessionId: string; cancel: () => Promise<void> }) => void;
      },
    ) =>
      new Promise((_resolve, reject) => {
        signal = options.signal;
        signal?.addEventListener("abort", () => reject(signal?.reason));
        options.onWaiting?.({ sessionId: "ours", cancel: async () => undefined });
      }),
  );
  const busy = vi.fn();
  const container = await mount(busy);
  await click("Connect OAuth");
  expect(container.textContent).toContain("Waiting for sign-in in the other window.");
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toContain(
    "Cancel sign-in",
  );
  expect(busy).toHaveBeenLastCalledWith(true);
  expect(signal?.aborted).toBe(false);
  await cleanup();
  expect(signal?.aborted).toBe(true);
});

it.each([
  ["a token", "mcp-secret"],
  ["a header", "header"],
])("checks a server added with %s once and says what the check found", async (_, field) => {
  const container = await mount();
  await click("Add MCP server");
  await fill("mcp-name", "Reports");
  await fill("mcp-endpoint", "https://tools.example.test/mcp");
  const input =
    field === "header"
      ? (document.querySelector('[aria-label="Header value"]') as HTMLInputElement)
      : (document.getElementById(field) as HTMLInputElement);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "synthetic-value",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  fake.create.mockResolvedValue(unchecked);
  fake.tools.mockImplementation(async () => {
    fake.list.mockResolvedValue([
      {
        ...unchecked,
        connectionState: "needs-sign-in",
        lastError: mcpSignInDiagnostic("credential_rejected"),
      },
    ]);
    throw new Error("rejected");
  });
  await click("Add server");
  expect(fake.tools).toHaveBeenCalledExactlyOnceWith({ serverId: "reports" });
  expect(container.textContent).toContain("That token was not accepted. Check it and try again.");
});

it("asks to keep one credential when a saved server still has two", async () => {
  fake.list.mockResolvedValue([
    {
      id: "reports",
      name: "Reports",
      transport: "streamable_http",
      oauthStatus: "none",
      connectionState: "connected",
      endpoint: "https://tools.example.test/mcp",
      enabled: true,
      catalogId: null,
      hasSecret: true,
      credentialConflict: true,
      lastError: null,
    } as McpServer,
    {
      id: "notes",
      name: "Notes",
      transport: "streamable_http",
      oauthStatus: "none",
      connectionState: "connected",
      endpoint: "https://notes.example.test/mcp",
      enabled: true,
      catalogId: null,
      hasSecret: true,
      lastError: null,
    } as McpServer,
  ]);
  const container = await mount();
  const reports = document.getElementById("mcp-server-reports");
  const notes = document.getElementById("mcp-server-notes");
  expect(reports?.textContent).toContain("This server has two credentials. Keep one.");
  expect(notes?.textContent).not.toContain("two credentials");
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
});

it("keeps the token and drops the header without asking for either value again", async () => {
  fake.list.mockResolvedValue([
    {
      id: "reports",
      name: "Reports",
      transport: "streamable_http",
      oauthStatus: "none",
      connectionState: "connected",
      endpoint: "https://tools.example.test/mcp",
      enabled: true,
      catalogId: null,
      hasSecret: true,
      headerKeys: ["Authorization"],
      credentialConflict: true,
      lastError: null,
    } as McpServer,
  ]);
  fake.update.mockResolvedValue({});
  await mount();
  await click("Keep token");
  expect(fake.update).toHaveBeenCalledExactlyOnceWith({ id: "reports", headers: {} });
});

it("replaces a custom server's token from its own card, without navigating away", async () => {
  const server = {
    id: "reports",
    name: "Reports",
    transport: "streamable_http",
    oauthStatus: "none",
    connectionState: "needs-sign-in",
    endpoint: "https://tools.example.test/mcp",
    enabled: true,
    catalogId: null,
    hasSecret: true,
    headerKeys: [] as string[],
    lastError: mcpSignInDiagnostic("credential_rejected"),
  } as McpServer;
  fake.list.mockResolvedValue([server]);
  fake.update.mockResolvedValue({});
  fake.tools.mockResolvedValue({ capturedAt: "", serverVersion: null, account: null, tools: [] });
  await mount();
  await click("Update credential");
  const field = document.querySelector('[aria-label="New access token"]') as HTMLInputElement;
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "fresh-token",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save");
  expect(fake.update).toHaveBeenCalledExactlyOnceWith({ id: "reports", secret: "fresh-token" });
  // A saved credential is checked once, the way the add flow does, so Reconnect
  // isn't sent straight back to this same form.
  expect(fake.tools).toHaveBeenCalledExactlyOnceWith({ serverId: "reports" });
});

it("keeps the header and drops the stale token with one click", async () => {
  fake.list.mockResolvedValue([
    {
      id: "reports",
      name: "Reports",
      transport: "streamable_http",
      oauthStatus: "none",
      connectionState: "connected",
      endpoint: "https://tools.example.test/mcp",
      enabled: true,
      catalogId: null,
      hasSecret: true,
      headerKeys: ["Authorization"],
      credentialConflict: true,
      lastError: null,
    } as McpServer,
  ]);
  fake.update.mockResolvedValue({});
  await mount();
  await click("Keep header");
  expect(fake.update).toHaveBeenCalledExactlyOnceWith({ id: "reports", secret: null });
});

it.each([
  ["Keep token", { id: "reports", headers: {} }],
  ["Keep header", { id: "reports", secret: null }],
])("shows its own failure next to %s when the update is rejected", async (label, call) => {
  fake.list.mockResolvedValue([
    {
      id: "reports",
      name: "Reports",
      transport: "streamable_http",
      oauthStatus: "none",
      connectionState: "connected",
      endpoint: "https://tools.example.test/mcp",
      enabled: true,
      catalogId: null,
      hasSecret: true,
      headerKeys: ["Authorization"],
      credentialConflict: true,
      lastError: null,
    } as McpServer,
  ]);
  fake.update.mockRejectedValue(new Error("rejected"));
  const container = await mount();
  await click(label);
  expect(fake.update).toHaveBeenCalledExactlyOnceWith(call);
  expect(container.textContent).toContain(
    "This server has two credentials. Keep one.Keep tokenKeep header" +
      "Could not save. Try again.",
  );
});

it("clears a stale save failure when Update credential is closed and reopened", async () => {
  const server = {
    id: "reports",
    name: "Reports",
    transport: "streamable_http",
    oauthStatus: "none",
    connectionState: "needs-sign-in",
    endpoint: "https://tools.example.test/mcp",
    enabled: true,
    catalogId: null,
    hasSecret: true,
    headerKeys: [] as string[],
    lastError: mcpSignInDiagnostic("credential_rejected"),
  } as McpServer;
  fake.list.mockResolvedValue([server]);
  fake.update.mockRejectedValueOnce(new Error("rejected"));
  const container = await mount();
  await click("Update credential");
  const field = document.querySelector('[aria-label="New access token"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "bad-token",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save");
  expect(container.textContent).toContain(
    "Could not save this credential. Check it and try again.",
  );
  await click("Cancel");
  await click("Update credential");
  expect(container.textContent).not.toContain(
    "Could not save this credential. Check it and try again.",
  );
});

it.each([
  ["a managed server", { managedBy: "extension" as const }],
  ["a stdio server", { transport: "stdio" as const }],
  ["a host-cli server", { transport: "host-cli" as const }],
  ["a healthy server", {}],
])("hides Update credential for %s", async (_, override) => {
  fake.list.mockResolvedValue([
    {
      id: "reports",
      name: "Reports",
      transport: "streamable_http",
      oauthStatus: "none",
      connectionState: "connected",
      endpoint: "https://tools.example.test/mcp",
      enabled: true,
      catalogId: null,
      hasSecret: true,
      headerKeys: [] as string[],
      envKeys: [] as string[],
      lastError: null,
      ...override,
    } as McpServer,
  ]);
  const container = await mount();
  expect(
    [...container.querySelectorAll("button")].some(
      (node) => node.textContent === "Update credential",
    ),
  ).toBe(false);
});

it("opens the credential control already focused when Reconnect needs a credential", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const server = {
    id: "reports",
    name: "Reports",
    transport: "streamable_http",
    oauthStatus: "reconnect",
    connectionState: "needs-sign-in",
    endpoint: "https://tools.example.test/mcp",
    enabled: true,
    catalogId: null,
    hasSecret: true,
    headerKeys: [] as string[],
    lastError: mcpSignInDiagnostic("credential_rejected"),
  } as McpServer;
  fake.list.mockResolvedValue([server]);
  await mount(undefined, { serverId: "reports", request: 1 });
  expect(document.querySelector('[aria-label="New access token"]')).not.toBeNull();
});
