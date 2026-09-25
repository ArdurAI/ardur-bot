// @vitest-environment jsdom
import type { McpServer } from "@ardurbot/contracts";
import { DEFAULT_MCP_SERVERS } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  logs: vi.fn(),
  assignments: vi.fn(),
  approve: vi.fn(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    mcp: {
      servers: { list: api.list, create: api.create, update: api.update },
      assignments: { all: api.assignments, replace: api.approve },
    },
    developer: { logs: api.logs },
    bots: { list: async () => [] },
  },
  selectedSpaceId: () => "space",
}));
vi.mock("../../components/integrations/catalog/McpToolReview", () => ({
  McpToolReview: ({ server }: { server: McpServer }) => (
    <div data-review={server.id}>Review tools for {server.name}</div>
  ),
}));
vi.mock("./McpConfigEditor", () => ({ McpConfigEditor: () => <div>Configuration review</div> }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Badge: Container,
    Card: Container,
    CardContent: Container,
    CardHeader: Container,
    CardTitle: Container,
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogFooter: Container,
    DialogClose: Container,
    Field: Container,
    FieldGroup: Container,
    FieldLabel: Container,
    FieldTitle: Container,
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: ReactNode;
      value: string;
      onValueChange(value: string): void;
    }) => (
      <select
        aria-label="Transport"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    ),
    TabsList: ({ children }: { children: ReactNode }) => children,
    TabsTrigger: ({ children, value }: { children: ReactNode; value: string }) => (
      <option value={value}>{children}</option>
    ),
    Input: Container,
    Button: ({
      variant: _variant,
      size: _size,
      render,
      children,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string; render?: ReactNode }) =>
      render ? (
        <span>
          {render}
          {children}
        </span>
      ) : (
        <button {...props}>{children}</button>
      ),
  };
});

import { McpServersOverlay } from "../McpServersOverlay";
import DeveloperPage from "./DeveloperPage";
import { McpDefaults } from "./McpDefaults";
import { McpDiagnostics } from "./McpDiagnostics";

const server = (fields: Partial<McpServer> = {}): McpServer => ({
  id: "local",
  name: "Local fixture",
  spaceId: "space",
  slug: "local",
  description: "",
  transport: "stdio",
  command: "node",
  endpoint: null,
  args: ["--token", "[redacted]"],
  envKeys: ["ACCESS_TOKEN"],
  headerKeys: [],
  hasSecret: true,
  enabled: true,
  revision: 1,
  oauthStatus: "none",
  createdAt: "",
  updatedAt: "",
  ...fields,
});
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      close() {}
    },
  );
  api.assignments.mockResolvedValue([]);
  api.logs.mockResolvedValue({ status: "running", lines: ["token=[redacted]"], lastError: null });
  host = document.createElement("div");
  root = createRoot(host);
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete window.ardurbotDesktop;
  vi.unstubAllGlobals();
});

it("routes desktop STDIO creation through native configuration review", async () => {
  api.list.mockResolvedValue([]);
  window.ardurbotDesktop = { customization: {} } as NonNullable<Window["ardurbotDesktop"]>;
  await act(async () => root.render(<McpServersOverlay embedded onClose={() => undefined} />));
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Add MCP server")!
      .click(),
  );
  const transport = host.querySelector<HTMLSelectElement>('select[aria-label="Transport"]')!;
  await act(async () => {
    transport.value = "stdio";
    transport.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("Configuration review");
  expect(api.create).not.toHaveBeenCalled();
});

it("retries failed diagnostics without exposing raw configuration", async () => {
  api.logs.mockRejectedValueOnce(new Error("Fixture failure"));
  await act(async () => root.render(<McpDiagnostics server={server()} />));
  expect(host.textContent).toContain("Could not load server diagnostics.");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Try again")!
      .click(),
  );
  expect(host.textContent).not.toContain("Could not load server diagnostics.");
  expect(host.textContent).toContain("Running");
});

it("offers defaults without connecting and opens review only after explicit enablement", async () => {
  const created = server({
    id: "default",
    transport: "streamable_http",
    endpoint: DEFAULT_MCP_SERVERS[0].endpoint,
  });
  api.create.mockResolvedValue(created);
  const review = vi.fn(async () => undefined);
  await act(async () => root.render(<McpDefaults servers={[]} onEnabled={review} />));
  expect(api.create).not.toHaveBeenCalled();
  expect(api.approve).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Context7");
  expect(host.textContent).toContain("DeepWiki");
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Enable")!.click(),
  );
  expect(api.create).toHaveBeenCalledWith({
    name: "Context7",
    slug: "context7",
    transport: "streamable_http",
    endpoint: "https://mcp.context7.com/mcp",
    headers: {},
    enabled: true,
  });
  expect(review).toHaveBeenCalledWith(created);
  expect(api.approve).not.toHaveBeenCalled();
});
it("re-enables a saved default with only an enabled patch", async () => {
  const saved = server({
    id: "saved",
    transport: "streamable_http",
    endpoint: DEFAULT_MCP_SERVERS[0].endpoint,
    enabled: false,
  });
  api.update.mockResolvedValue({ ...saved, enabled: true });
  await act(async () =>
    root.render(<McpDefaults servers={[saved]} onEnabled={async () => undefined} />),
  );
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Enable")!.click(),
  );
  expect(api.update).toHaveBeenCalledExactlyOnceWith({ id: "saved", enabled: true });
  expect(api.create).not.toHaveBeenCalled();
});
it("keeps product accounts out of MCP and shows managed local diagnostics without delete controls", async () => {
  api.list.mockResolvedValue([
    server({ id: "product", name: "Product account", catalogId: "github" }),
    server({ managedBy: "extension" }),
  ]);
  await act(async () => root.render(<McpServersOverlay embedded onClose={() => undefined} />));
  expect(host.textContent).not.toContain("Product account");
  expect(host.textContent).toContain("This server is managed by an extension");
  expect(host.textContent).toContain("Running");
  expect(host.textContent).toContain("ACCESS_TOKEN");
  expect(
    [...host.querySelectorAll("button")].some((button) => button.textContent === "Delete"),
  ).toBe(false);
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "View logs")!
      .click(),
  );
  expect(host.querySelector('[aria-label="Server logs"]')?.textContent).toContain(
    "token=[redacted]",
  );
  expect(api.approve).not.toHaveBeenCalled();
});
it("leaves only desktop server identity in Developer", async () => {
  window.ardurbotDesktop = {
    update: { state: async () => ({ currentVersion: "1.2.3" }) },
  } as NonNullable<Window["ardurbotDesktop"]>;
  await act(async () => root.render(<DeveloperPage />));
  expect(host.textContent).toContain("Server URL");
  expect(host.textContent).toContain("1.2.3");
  expect(host.textContent).not.toContain("MCP");
  expect(api.list).not.toHaveBeenCalled();
  expect(api.logs).not.toHaveBeenCalled();
});
