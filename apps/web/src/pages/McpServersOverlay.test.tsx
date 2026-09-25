// @vitest-environment jsdom
import type { McpServer } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), remove: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    mcp: { servers: fake, assignments: { all: async () => [] } },
    bots: { list: async () => [] },
  },
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
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () => root.render(<McpServersOverlay embedded onClose={vi.fn()} />));
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
