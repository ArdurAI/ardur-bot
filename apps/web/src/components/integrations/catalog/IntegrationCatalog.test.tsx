// @vitest-environment jsdom
import type { IntegrationConnection, IntegrationDescriptor } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationCatalog } from "./IntegrationCatalog";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  servers: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  tools: vi.fn(),
  approve: vi.fn(),
  connect: vi.fn(),
  grants: vi.fn(),
  assign: vi.fn(),
  revoke: vi.fn(),
  cancel: vi.fn(),
  bots: vi.fn(),
  consent: vi.fn(),
  oauth: vi.fn(),
  catalogSearch: vi.fn(),
  discover: vi.fn(),
  resourceTools: vi.fn(),
  searchResources: vi.fn(),
  computers: vi.fn(),
}));
vi.mock("../../../lib/rpc", () => ({
  selectedSpaceId: () => "space",
  rpc: {
    integrations: api,
    bots: { list: api.bots },
    computer: { list: api.computers },
    capabilities: { catalogSearch: api.catalogSearch },
    mcp: {
      servers: {
        list: api.servers,
        create: api.create,
        update: api.update,
        remove: api.remove,
        tools: api.tools,
      },
      assignments: { approve: api.approve },
    },
  },
}));
vi.mock("../../../lib/mcp-connect", () => ({
  MCP_OAUTH_CHANNEL: "test",
  waitForMcpOauth: api.consent,
  connectMcpOauth: api.oauth,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = (props: ComponentProps<"div">) => <div {...props} />;
  return {
    Toggle: ({
      pressed,
      onPressedChange,
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & {
      pressed: boolean;
      onPressedChange: (pressed: boolean) => void;
      variant?: string;
      size?: string;
    }) => <button {...props} aria-pressed={pressed} onClick={() => onPressedChange(!pressed)} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
    Badge: Container,
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
        aria-label="Source"
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
    Card: Container,
    CardContent: Container,
    CardHeader: Container,
    CardTitle: Container,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Button: ({
      variant: _variant,
      render,
      size: _size,
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
    Checkbox: ({
      checked,
      onCheckedChange,
      ...props
    }: Omit<ComponentProps<"input">, "onChange"> & {
      onCheckedChange: (checked: boolean) => void;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        {...props}
      />
    ),
  };
});

const catalog: IntegrationDescriptor[] = [
  "github",
  "gitlab",
  "atlassian",
  "jenkins",
  "kubernetes",
  "aws",
  "google-cloud",
  "azure",
].map((id, index) => ({
  id,
  name: ["GitHub", "GitLab", "Atlassian", "Jenkins", "Kubernetes", "AWS", "Google Cloud", "Azure"][
    index
  ]!,
  vendor: id,
  available: true,
  ...(index < 3
    ? { endpoint: "https://example.test/mcp" }
    : { hostCli: { command: "test-cli", installUrl: "https://example.test/install" } }),
  transport: "remote-http",
  authKind: "oauth",
  requiredInputs: [],
  docsUrl: "https://example.test/docs",
  verifiedAt: "2026-09-23",
  serverVersion: null,
  placement: "backend",
  riskClass: index < 3 ? "collaboration" : "infrastructure",
  defaultAllowedTools: [],
  toolPolicies: {},
}));
const connected: IntegrationConnection = {
  id: "connection",
  catalogId: "github",
  state: "connected",
  needsReview: false,
  spaceToolPolicies: {},
  manifest: {
    capturedAt: "2026-09-23T00:00:00.000Z",
    serverVersion: null,
    account: null,
    tools: [
      {
        id: "synthetic_read",
        description: "Synthetic fixture read",
        inputSchemaDigest: "a".repeat(64),
      },
      {
        id: "synthetic_update",
        description: "Synthetic fixture write",
        inputSchemaDigest: "b".repeat(64),
      },
    ],
  },
};
let connections: IntegrationConnection[];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let broadcast: { onmessage: ((event: MessageEvent) => void) | null };
beforeEach(() => {
  vi.clearAllMocks();
  connections = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null;
      constructor() {
        broadcast = this;
      }
      close() {}
    },
  );
  vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
  api.list.mockImplementation(async () => ({ catalog, connections }));
  api.servers.mockImplementation(async () =>
    connections.map((connection) => ({
      id: connection.id,
      name: catalog.find((item) => item.id === connection.catalogId)?.name,
      catalogId: connection.catalogId,
      transport: "streamable_http",
      enabled: connection.state !== "not-connected",
      oauthStatus: "none",
      connectionState: connection.state,
    })),
  );
  api.bots.mockResolvedValue([{ id: "bot", name: "Helper", archivedAt: null }]);
  api.grants.mockResolvedValue([]);
  api.computers.mockResolvedValue([{ botId: "bot", status: { kind: "desktop" } }]);
  api.resourceTools.mockResolvedValue([]);
  api.searchResources.mockResolvedValue([]);
  api.assign.mockImplementation(async (input) =>
    input.botIds.map((botId: string) => ({ botId, toolIds: input.toolIds, needsReview: false })),
  );
  api.connect.mockImplementation(async () => {
    connections = [connected];
    return {
      connection: connected,
      authorizationUrl: null,
      sessionId: "session",
    };
  });
  api.consent.mockResolvedValue("connected");
  api.oauth.mockResolvedValue("connected");
  api.remove.mockResolvedValue({ ok: true });
  api.tools.mockResolvedValue({ capturedAt: "", serverVersion: null, account: null, tools: [] });
  api.catalogSearch.mockResolvedValue({ enabled: true, results: [] });
  api.revoke.mockImplementation(async () => {
    connections = [{ ...connected, state: "not-connected", manifest: null }];
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (text: string, within: Element = container) =>
  [...within.querySelectorAll("button")].find((button) => button.textContent === text)!;
const mount = async () => {
  await act(async () => root.render(<IntegrationCatalog />));
};
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};

describe("Settings integration catalog", () => {
  it("shows local and remote accounts once and reconnects through the selected Manage view", async () => {
    const local = { ...connected, id: "local", transport: "host-cli" as const };
    const remote = {
      ...connected,
      state: "needs-sign-in" as const,
      transport: "streamable_http" as const,
    };
    api.list.mockResolvedValue({
      catalog: [
        { ...catalog[0]!, hostCli: { command: "gh", installUrl: "https://example.test/install" } },
      ],
      connections: [local, remote],
      hostSignIns: [{ id: "github", state: "signed-in", identity: "fixture-account" }],
    });
    await mount();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.textContent).toContain("Desktop / Web");
    expect(container.textContent).toContain("Signed in on this computer as fixture-account");
    expect(container.textContent).toContain("Needs reconnection");
    const manage = [...container.querySelectorAll("button")].filter(
      (node) => node.textContent === "Manage",
    );
    expect(manage).toHaveLength(2);
    await click(manage[1]!);
    expect(container.querySelector("table")).toBeNull();
    expect(
      [...container.querySelectorAll("button")].filter((node) => node.textContent === "Reconnect"),
    ).toHaveLength(1);
    await click(button("Reconnect"));
    expect(api.connect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ connectionId: remote.id, authKind: "oauth" }),
    );
  });
  it("filters Yours and Catalog without mixing custom MCP servers into product accounts", async () => {
    connections = [connected];
    await mount();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(8);
    const source = container.querySelector<HTMLSelectElement>('select[aria-label="Source"]')!;
    await act(async () => {
      source.value = "yours";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector("tbody")?.textContent).toContain("GitHub");
    await fill("Search integrations", "no match");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(container.textContent).toContain("No items found.");
  });
  it("shows eight table rows with remote and host options", async () => {
    await mount();
    expect(container.querySelectorAll('[data-testid^="integration-"]')).toHaveLength(9);
    expect(
      [...container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Connect",
      ),
    ).toHaveLength(3);
    expect(container.textContent).not.toContain("Coming soon");
    expect(container.textContent?.match(/Open the desktop app/g)).toHaveLength(5);
    expect(container.querySelector('[aria-label="GitLab host"]')?.closest("details")?.open).toBe(
      false,
    );
    expect(container.textContent).not.toContain("api.githubcopilot");
  });
  it("connects, starts with no grants, then saves only the selected bots and tools", async () => {
    await mount();
    await click(button("Connect", container.querySelector('[data-testid="integration-github"]')!));
    expect(api.connect).toHaveBeenCalledWith({
      catalogId: "github",
      connectionId: undefined,
      host: undefined,
      authKind: "oauth",
      token: undefined,
    });
    expect(api.assign).not.toHaveBeenCalled();
    const checks = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checks).toHaveLength(1);
    expect(checks.every((input) => !input.checked)).toBe(true);
    expect(container.querySelectorAll("select")).toHaveLength(2);
    await click(container.querySelector('[aria-label="Helper"]')!);
    await permission("synthetic_update", "ask");
    await click(button("Save"));
    expect(api.assign).toHaveBeenCalledWith({
      connectionId: "connection",
      botIds: ["bot"],
      toolIds: ["synthetic_update"],
      spaceToolPolicies: { synthetic_update: "ask-first" },
    });
    expect(container.textContent).toContain("Your bots can use the selected tools.");
    await click(button("Disconnect"));
    expect(api.revoke).toHaveBeenCalledWith({ connectionId: "connection" });
    expect(
      button("Connect", container.querySelector('[data-testid="integration-github"]')!),
    ).toBeDefined();
  });
  it("loads, changes, saves and reopens a per-connection read approval", async () => {
    connections = [{ ...connected, spaceToolPolicies: { synthetic_read: "allow" } }];
    api.grants.mockResolvedValue([
      { botId: "bot", toolIds: ["synthetic_read"], needsReview: false },
    ]);
    api.assign.mockImplementation(async (input) => {
      connections = [{ ...connected, spaceToolPolicies: input.spaceToolPolicies }];
      return [{ botId: "bot", toolIds: input.toolIds, needsReview: false }];
    });
    await mount();
    await click(button("Manage"));
    const approval = () =>
      container.querySelector<HTMLSelectElement>('[aria-label="Permission for synthetic_read"]')!;
    expect(approval().value).toBe("allow");
    await permission("synthetic_read", "ask");
    expect(approval().value).toBe("ask");
    await click(button("Save"));
    expect(api.assign).toHaveBeenCalledWith({
      connectionId: "connection",
      botIds: ["bot"],
      toolIds: ["synthetic_read"],
      spaceToolPolicies: { synthetic_read: "ask-first" },
    });
    await click(button("Back"));
    await click(button("Manage"));
    expect(approval().value).toBe("ask");
  });
  it("shows registration help and review state with one primary action", async () => {
    connections = [
      { ...connected, state: "needs-client-registration" },
      { ...connected, id: "gitlab", catalogId: "gitlab", needsReview: true },
    ];
    await mount();
    const github = container.querySelector('[data-testid="integration-github"]')!;
    expect(github.textContent).toContain("needs client registration");
    expect(button("Connect", github)).toBeDefined();
    expect(github.textContent).not.toContain("Connect your account");
    expect(button("Manage")).toBeDefined();
  });
  it("shows a pending consent sentence and allows cancellation while the browser is open", async () => {
    connections = [{ ...connected, state: "awaiting-consent", manifest: null }];
    api.cancel.mockImplementation(async () => {
      connections = [{ ...connected, state: "cancelled", manifest: null }];
    });
    await mount();
    expect(container.textContent).toContain("Finish signing in in your browser.");
    expect(button("Cancel").disabled).toBe(false);
    await click(button("Cancel"));
    expect(api.cancel).toHaveBeenCalledWith({ connectionId: "connection" });
    expect(container.textContent).toContain("The connection was cancelled.");
  });

  it("surfaces load errors without provider text", async () => {
    api.list.mockRejectedValueOnce(new Error("fake-sensitive-provider-response"));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not connect or load integrations.",
    );
    expect(container.textContent).not.toContain("fake-sensitive");
    expect(button("Try again")).toBeDefined();
  });

  it("keeps a built-in app's row when a raw server uses its address", async () => {
    api.servers.mockImplementation(async () => [
      {
        id: "raw-server",
        name: "Self-added server",
        endpoint: "https://example.test/mcp",
        transport: "streamable_http",
        enabled: true,
        oauthStatus: "connected",
        connectionState: "not-connected",
        catalogId: null,
      },
    ]);
    await mount();
    const githubRow = [...container.querySelectorAll("tbody tr")].find((entry) =>
      entry.textContent?.includes("GitHub"),
    );
    expect(githubRow?.textContent).not.toContain("Manage");
    expect(container.textContent).not.toContain("Self-added server");
  });

  it("renders Find apps and keeps public search closed until it is opened", async () => {
    await mount();
    expect(container.querySelector('[aria-label="Search apps"]')).toBeNull();
    expect(button("Find apps")).toBeDefined();
    await click(button("Find apps"));
    expect(container.querySelector('[aria-label="Search apps"]')).not.toBeNull();
    expect(button("Search integrations.sh")).toBeDefined();
    expect(container.textContent).toContain("Add server URL");
  });

  it("searches the public catalog and lists each result with Connect", async () => {
    api.catalogSearch.mockResolvedValue({
      enabled: true,
      results: [publicResult],
    });
    await mount();
    await click(button("Find apps"));
    await fill("Search apps", "Figma");
    await click(button("Search integrations.sh"));
    expect(api.catalogSearch).toHaveBeenCalledWith({ query: "Figma", usePublicCatalog: true });
    expect(resultConnect("Figma")).toBeDefined();
  });

  it("keeps a directory query on a built-in path as a custom server", async () => {
    api.list.mockResolvedValue({
      catalog: [
        {
          ...catalog[0]!,
          id: "notion",
          name: "Notion",
          endpoint: "https://mcp.notion.com/mcp",
        },
      ],
      connections: [],
    });
    api.catalogSearch.mockResolvedValue({
      enabled: true,
      results: [
        {
          ...publicResult,
          name: "Community Notion listing",
          surfaces: [
            {
              kind: "mcp",
              slug: "notion",
              source: "https://mcp.notion.com/mcp/?source=directory",
              auth: null,
            },
          ],
        },
      ],
    });
    createdServers();
    await mount();
    await click(button("Find apps"));
    await fill("Search apps", "notion");
    await click(button("Search integrations.sh"));
    expect(resultConnect("Notion")).toBeUndefined();
    await click(resultConnect("Community Notion listing")!);
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://mcp.notion.com/mcp/?source=directory" }),
    );
    expect(api.connect).not.toHaveBeenCalled();
  });

  it("asks for a bearer value and discovers without starting OAuth", async () => {
    const added: Array<Record<string, unknown>> = [];
    api.catalogSearch.mockResolvedValue({
      enabled: true,
      results: [
        {
          ...publicResult,
          surfaces: [
            {
              ...publicResult.surfaces[0]!,
              auth: { type: "bearer", headerName: null, note: null },
            },
          ],
        },
      ],
    });
    api.create.mockImplementation(async (input: { name: string; endpoint: string }) => {
      const server = {
        id: "bearer-server",
        name: input.name,
        endpoint: input.endpoint,
        transport: "streamable_http",
        enabled: true,
        oauthStatus: "none",
        connectionState: "not-connected",
        catalogId: null,
      };
      added.push(server);
      return server;
    });
    api.tools.mockImplementation(async () => {
      added[0]!.connectionState = "connected";
      return { capturedAt: "", serverVersion: null, account: null, tools: [] };
    });
    api.servers.mockImplementation(async () => added);
    await mount();
    await click(button("Find apps"));
    await fill("Search apps", "figma");
    await click(button("Search integrations.sh"));
    await click(resultConnect("Figma")!);
    expect(container.querySelector('[aria-label="Credential"]')).not.toBeNull();
    await fill("Credential", "synthetic-test-value");
    await click(resultConnect("Figma")!);
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "synthetic-test-value" }),
    );
    expect(api.tools).toHaveBeenCalledWith({ serverId: "bearer-server" });
    expect(api.oauth).not.toHaveBeenCalled();
  });

  it("keeps a just-created custom server when sign-in is declined and offers reconnect", async () => {
    const polls: Array<() => void> = [];
    const setInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation(((handler: () => void, ms?: number) => {
      if (ms !== 5000) return setInterval(handler, ms);
      polls.push(handler);
      return 0;
    }) as typeof window.setInterval);
    const added = createdServers();
    api.oauth.mockImplementation(async (serverId: string) => {
      const server = added.find((entry) => entry.id === serverId)!;
      server.connectionState = "cancelled";
      return "cancelled";
    });
    await openResults([publicResult]);
    await click(resultConnect("Figma")!);
    expect(api.create).toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Sign-in was declined. Reconnect to try again.");
    await act(async () => polls[0]!());
    const row = serverRow("Figma");
    expect(row?.textContent).toContain("Needs sign-in");
    expect(row?.textContent).toContain("Reconnect");
    expect(row?.textContent).toContain("Manage");
    expect(row?.textContent).toContain("Delete");
  });

  it("does not report authorization-not-requested when discovery failed", async () => {
    api.catalogSearch.mockResolvedValue({ enabled: true, results: [publicResult] });
    api.create.mockResolvedValue({
      id: "failed-server",
      name: "Figma",
      endpoint: "https://mcp.figma.example.test/mcp",
      transport: "streamable_http",
      enabled: true,
      oauthStatus: "none",
      connectionState: "not-connected",
      catalogId: null,
    });
    api.oauth.mockResolvedValueOnce("authorization_not_requested");
    let serverLists = 0;
    api.servers.mockImplementation(async () => {
      serverLists += 1;
      return serverLists < 3
        ? []
        : [
            {
              id: "failed-server",
              name: "Figma",
              endpoint: "https://mcp.figma.example.test/mcp",
              transport: "streamable_http",
              enabled: true,
              oauthStatus: "none",
              connectionState: "discovery-failed",
              catalogId: null,
            },
          ];
    });
    await mount();
    await click(button("Find apps"));
    await fill("Search apps", "figma");
    await click(button("Search integrations.sh"));
    await click(resultConnect("Figma")!);
    expect(container.textContent).toContain("Could not connect or load integrations.");
    expect(container.textContent).not.toContain("Connected");
  });

  it("shows a custom server's recorded discovery failure even when it holds OAuth tokens", async () => {
    api.servers.mockResolvedValue([
      {
        id: "persisted-server",
        name: "Persisted server",
        endpoint: "https://custom.example.test/mcp",
        transport: "streamable_http",
        enabled: true,
        oauthStatus: "connected",
        connectionState: "discovery-failed",
        catalogId: null,
      },
    ]);
    await mount();
    const row = [...container.querySelectorAll("tbody tr")].find((entry) =>
      entry.textContent?.includes("Persisted server"),
    );
    expect(row?.textContent).not.toContain("Connected");
    expect(button("Reconnect")).toBeDefined();
  });

  it("offers Reconnect, Manage, and a confirmed Delete for a failed custom server", async () => {
    const onOpenMcp = vi.fn();
    api.servers.mockResolvedValue([
      {
        id: "failed-custom",
        name: "Failed custom server",
        endpoint: "https://failed.example.test/mcp",
        transport: "streamable_http",
        enabled: true,
        oauthStatus: "reconnect",
        connectionState: "discovery-failed",
        catalogId: null,
      },
    ]);
    await act(async () => root.render(<IntegrationCatalog onOpenMcp={onOpenMcp} />));
    expect(button("Reconnect")).toBeDefined();
    await click(button("Manage"));
    expect(onOpenMcp).toHaveBeenCalledWith("failed-custom");
    await click(button("Delete"));
    expect(api.remove).not.toHaveBeenCalled();
    await click(button("Confirm delete"));
    expect(api.remove).toHaveBeenCalledExactlyOnceWith({ id: "failed-custom" });
  });

  it("does not start a poll while a list request is in flight", async () => {
    const polls: Array<() => void> = [];
    const setInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation(((handler: () => void, ms?: number) => {
      if (ms !== 5000) return setInterval(handler, ms);
      polls.push(handler);
      return 0;
    }) as typeof window.setInterval);
    let resolveFirst!: (value: Array<Record<string, unknown>>) => void;
    api.servers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    await mount();
    expect(api.servers).toHaveBeenCalledTimes(1);
    await act(async () => polls[0]!());
    expect(api.servers).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolveFirst([
        {
          id: "slow-server",
          name: "Slow server",
          endpoint: "https://slow.example.test/mcp",
          transport: "streamable_http",
          enabled: true,
          oauthStatus: "none",
          connectionState: "connected",
          catalogId: null,
        },
      ]),
    );
    expect(container.textContent).toContain("Slow server");
    await act(async () => polls[0]!());
    expect(api.servers).toHaveBeenCalledTimes(2);
  });

  it("never carries one result's credential to another result", async () => {
    const added = createdServers();
    await openResults([
      listing("Alpha", "https://alpha.example.test/mcp", bearer),
      listing("Beta", "https://beta.example.test/mcp", bearer),
    ]);
    await click(resultConnect("Alpha")!);
    await fill("Credential", "synthetic-alpha");
    await click(resultConnect("Beta")!);
    expect(container.querySelectorAll('[aria-label="Credential"]')).toHaveLength(1);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Credential"]')?.value).toBe("");
    await fill("Credential", "synthetic-beta");
    await click(resultConnect("Beta")!);
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        endpoint: "https://beta.example.test/mcp",
        secret: "synthetic-beta",
      }),
    );
    expect(added).toHaveLength(1);
  });

  it("reuses a saved server only when its whole address, including the query, matches", async () => {
    const added = createdServers([
      {
        id: "saved",
        slug: "saved",
        name: "Workspace A",
        description: "",
        endpoint: "https://mcp.example.test/mcp?workspace=a&region=eu",
        transport: "streamable_http",
        enabled: true,
        oauthStatus: "none",
        connectionState: "connected",
        catalogId: null,
      },
    ]);
    await openResults([
      listing("Workspace B", "https://mcp.example.test/mcp?workspace=b", bearer),
      listing("Workspace A again", "https://MCP.example.test/mcp/?region=eu&workspace=a", bearer),
    ]);
    await click(resultConnect("Workspace B")!);
    await fill("Credential", "synthetic-b");
    await click(resultConnect("Workspace B")!);
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        endpoint: "https://mcp.example.test/mcp?workspace=b",
        secret: "synthetic-b",
      }),
    );
    expect(api.update).not.toHaveBeenCalled();
    await click(resultConnect("Workspace A again")!);
    await fill("Credential", "synthetic-a");
    await click(resultConnect("Workspace A again")!);
    expect(api.update).toHaveBeenCalledExactlyOnceWith({ id: "saved", secret: "synthetic-a" });
    expect(added).toHaveLength(2);
  });

  it("sends a header credential under the advertised header name", async () => {
    createdServers();
    await openResults([
      listing("Keyed", "https://keyed.example.test/mcp", {
        type: "header",
        headerName: "x-api-key",
        note: null,
      }),
    ]);
    await click(resultConnect("Keyed")!);
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Credential"]')?.placeholder,
    ).toBe("x-api-key");
    await fill("Credential", "synthetic-key");
    await click(resultConnect("Keyed")!);
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ headers: { "x-api-key": "synthetic-key" } }),
    );
    expect(api.create.mock.calls[0]![0]).not.toHaveProperty("secret");
    expect(api.tools).toHaveBeenCalledOnce();
    expect(api.oauth).not.toHaveBeenCalled();
  });

  it("signs in first for a mixed listing and asks for a token only when sign-in is unavailable", async () => {
    const added = createdServers();
    api.oauth.mockImplementationOnce(async (serverId: string) => {
      added.find((server) => server.id === serverId)!.connectionState = "needs-sign-in";
      throw new Error("fake-provider-response");
    });
    await openResults([
      listing("Either", "https://either.example.test/mcp", {
        type: "mixed",
        headerName: null,
        note: null,
      }),
    ]);
    await click(resultConnect("Either")!);
    expect(api.oauth).toHaveBeenCalledExactlyOnceWith("created-1");
    expect(api.remove).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await fill("Credential", "synthetic-token");
    await click(resultConnect("Either")!);
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.update).toHaveBeenCalledExactlyOnceWith({
      id: "created-1",
      secret: "synthetic-token",
    });
    expect(api.tools).toHaveBeenCalledExactlyOnceWith({ serverId: "created-1" });
    expect(api.oauth).toHaveBeenCalledOnce();
    expect(resultConnect("Either")).toBeUndefined();
  });

  it("starts the sign-in probe for a typed URL without a token", async () => {
    createdServers();
    await mount();
    await click(button("Find apps"));
    await fill("Server URL", "https://typed.example.test/mcp");
    const form = container.querySelector('[aria-label="Server URL"]')!.parentElement!;
    await click(button("Connect", form));
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ secret: expect.anything() }),
    );
    expect(api.oauth).toHaveBeenCalledExactlyOnceWith("created-1");
    expect(api.tools).not.toHaveBeenCalled();
  });

  it("starts the catalog flow with a token typed beside a built-in URL", async () => {
    const github = {
      ...remoteApp("github", "GitHub", "https://api.githubcopilot.com/mcp/"),
      authKind: "token" as const,
    };
    api.list.mockImplementation(async () => ({ catalog: [github], connections }));
    api.connect.mockResolvedValue({
      connection: { ...connected, catalogId: "github", state: "connected" },
      authorizationUrl: null,
      sessionId: null,
    });
    await mount();
    await click(button("Find apps"));
    const details = container.querySelector("details")!;
    await fill("Server URL", "https://api.githubcopilot.com/mcp/");
    expect(details.textContent).toContain("GitHub");
    await fill("Access token (optional)", "synthetic-test-value");
    await click(button("Connect", details));
    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: "github",
        authKind: "token",
        token: "synthetic-test-value",
      }),
    );
    expect(api.create).not.toHaveBeenCalled();
  });

  it("hides the token field for a built-in app that uses sign-in only", async () => {
    api.list.mockImplementation(async () => ({
      catalog: [remoteApp("atlassian", "Atlassian", "https://mcp.atlassian.com/v2/mcp?tools=all")],
      connections,
    }));
    await mount();
    await click(button("Find apps"));
    const details = container.querySelector("details")!;
    await fill("Server URL", "https://mcp.atlassian.com/v2/mcp?tools=all");
    expect(details.textContent).toContain("Atlassian");
    expect(details.querySelector('[aria-label="Access token (optional)"]')).toBeNull();
  });

  it("ignores an older server-list response that resolves after a refresh", async () => {
    let resolveOld!: (value: Array<Record<string, unknown>>) => void;
    const old = new Promise<Array<Record<string, unknown>>>((resolve) => {
      resolveOld = resolve;
    });
    api.servers
      .mockImplementationOnce(() => old)
      .mockResolvedValueOnce([
        {
          id: "new-server",
          name: "Newest server",
          endpoint: "https://new.example.test/mcp",
          transport: "streamable_http",
          enabled: true,
          oauthStatus: "none",
          connectionState: "connected",
          catalogId: null,
        },
      ]);
    await act(async () => root.render(<IntegrationCatalog />));
    await act(async () => {
      broadcast.onmessage?.(new MessageEvent("message"));
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Newest server"));
    await act(async () => resolveOld([]));
    expect(container.textContent).toContain("Newest server");
  });

  it("shows a plain search failure with Retry and hides the handler message", async () => {
    api.catalogSearch.mockRejectedValueOnce(new Error("Integration catalog returned HTTP 503"));
    await mount();
    await click(button("Find apps"));
    await fill("Search apps", "notion");
    await click(button("Search integrations.sh"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not search integrations.",
    );
    expect(container.textContent).not.toContain("HTTP 503");
    expect(button("Retry")).toBeDefined();
  });

  it("connecting a public catalog result refreshes the table", async () => {
    const added: Array<Record<string, unknown>> = [];
    api.catalogSearch.mockResolvedValue({ enabled: true, results: [publicResult] });
    api.servers.mockImplementation(async () => [
      ...connections.map((connection) => ({
        id: connection.id,
        name: catalog.find((item) => item.id === connection.catalogId)?.name,
        catalogId: connection.catalogId,
        transport: "streamable_http",
        enabled: connection.state !== "not-connected",
        oauthStatus: "none",
        connectionState: connection.state,
      })),
      ...added,
    ]);
    api.create.mockImplementation(async (input: { name: string; endpoint: string }) => {
      const server = {
        id: "added-server",
        name: input.name,
        endpoint: input.endpoint,
        transport: "streamable_http",
        enabled: true,
        oauthStatus: "connected",
        connectionState: "connected",
        catalogId: null,
      };
      added.push(server);
      return server;
    });
    await mount();
    await click(button("Find apps"));
    await fill("Search apps", "Figma");
    await click(button("Search integrations.sh"));
    const listsBefore = api.list.mock.calls.length;
    await click(resultConnect("Figma")!);
    await vi.waitFor(() => {
      expect(api.list.mock.calls.length).toBeGreaterThan(listsBefore);
      const row = [...container.querySelectorAll("tbody tr")].find((entry) =>
        entry.textContent?.includes("Figma"),
      );
      expect(row?.textContent).toContain("Connected");
    });
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Figma",
        transport: "streamable_http",
        endpoint: "https://mcp.figma.example.test/mcp",
      }),
    );
  });

  it("keeps a custom server that is waiting for sign-in or was cancelled", async () => {
    const polls: Array<() => void> = [];
    const setInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation(((handler: () => void, ms?: number) => {
      if (ms !== 5000) return setInterval(handler, ms);
      polls.push(handler);
      return 0;
    }) as typeof window.setInterval);
    const pending = customServer("pending", "Pending server", "not-connected");
    const declined = customServer("declined", "Declined server", "cancelled");
    api.servers.mockResolvedValue([pending, declined]);
    await mount();
    for (const name of ["Pending server", "Declined server"]) {
      const row = serverRow(name);
      expect(row?.textContent).toContain("Needs sign-in");
      expect(row?.textContent).toContain("Reconnect");
      expect(row?.textContent).toContain("Manage");
      expect(row?.textContent).toContain("Delete");
    }
    await act(async () => polls[0]!());
    expect(serverRow("Pending server")).toBeDefined();
    expect(serverRow("Declined server")).toBeDefined();
    await click(button("Delete", serverRow("Pending server")!));
    expect(api.remove).not.toHaveBeenCalled();
    await click(button("Confirm delete", serverRow("Pending server")!));
    expect(api.remove).toHaveBeenCalledExactlyOnceWith({ id: "pending" });
  });

  it("matches a built-in app only when the query is empty or the catalog query", async () => {
    const atlassian = "https://mcp.atlassian.com/v2/mcp?tools=all";
    const aws = "https://aws-mcp.us-east-1.api.aws/mcp?oauth=initialize";
    api.list.mockResolvedValue({
      catalog: [
        remoteApp("atlassian", "Atlassian", atlassian),
        remoteApp("aws", "AWS", aws),
        remoteApp("boards", "Boards", "https://boards.example.test/mcp?b=1&a=2"),
      ],
      connections: [],
    });
    api.connect.mockResolvedValue({
      connection: { ...connected, state: "connected" },
      authorizationUrl: null,
      sessionId: null,
    });
    createdServers();
    await openResults([
      listing("Jira tools", "https://mcp.atlassian.com/v2/mcp?tools=jira"),
      listing("All tools", atlassian),
      listing("AWS other", "https://aws-mcp.us-east-1.api.aws/mcp?oauth=start"),
      listing("AWS init", aws),
    ]);
    await click(resultConnect("Jira tools")!);
    expect(api.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ endpoint: "https://mcp.atlassian.com/v2/mcp?tools=jira" }),
    );
    expect(api.connect).not.toHaveBeenCalled();
    await click(resultConnect("Atlassian")!);
    expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({ catalogId: "atlassian" }));
    await click(resultConnect("AWS other")!);
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://aws-mcp.us-east-1.api.aws/mcp?oauth=start",
      }),
    );
    await click(resultConnect("AWS")!);
    expect(api.connect).toHaveBeenCalledWith(expect.objectContaining({ catalogId: "aws" }));

    const details = container.querySelector("details")!;
    await fill("Server URL", "https://mcp.atlassian.com/v2/mcp");
    expect(details.textContent).toContain("Atlassian");
    await fill("Server URL", "https://MCP.atlassian.com/v2/mcp/?tools=all");
    expect(details.textContent).toContain("Atlassian");
    await fill("Server URL", "https://aws-mcp.us-east-1.api.aws/mcp");
    expect(details.textContent).toContain("AWS");
    await fill("Server URL", "https://boards.example.test/mcp?a=2&b=1");
    expect(details.textContent).toContain("Boards");
    await fill("Server URL", "https://mcp.atlassian.com/v2/mcp?tools=jira");
    expect(details.textContent).not.toContain("Atlassian");
    await fill("Server URL", "https://boards.example.test/mcp?a=2&b=3");
    expect(details.textContent).not.toContain("Boards");
    const creates = api.create.mock.calls.length;
    await click(button("Connect", details));
    expect(api.create.mock.calls.length).toBe(creates + 1);
    expect(api.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: "https://boards.example.test/mcp?a=2&b=3" }),
    );
  });

  it("lists a custom server whose query differs from the built-in app", async () => {
    api.list.mockResolvedValue({
      catalog: [
        remoteApp("atlassian", "Atlassian", "https://mcp.atlassian.com/v2/mcp?tools=all"),
        remoteApp("aws", "AWS", "https://aws-mcp.us-east-1.api.aws/mcp?oauth=initialize"),
      ],
      connections: [],
    });
    api.servers.mockResolvedValue([
      customServer("jira", "Jira only", "connected", "https://mcp.atlassian.com/v2/mcp?tools=jira"),
      customServer(
        "all",
        "All tools custom",
        "connected",
        "https://mcp.atlassian.com/v2/mcp?tools=all",
      ),
      customServer("bare", "Bare path", "connected", "https://mcp.atlassian.com/v2/mcp"),
      customServer(
        "aws-other",
        "AWS other account",
        "connected",
        "https://aws-mcp.us-east-1.api.aws/mcp?oauth=start",
      ),
    ]);
    await mount();
    expect(container.textContent).toContain("Jira only");
    expect(container.textContent).toContain("AWS other account");
    expect(container.textContent).not.toContain("All tools custom");
    expect(container.textContent).not.toContain("Bare path");
  });

  it("reports a rejected token on a mixed or bearer listing and keeps the server", async () => {
    const added = createdServers();
    api.oauth.mockImplementationOnce(async (serverId: string) => {
      const server = added.find((entry) => entry.id === serverId)!;
      server.connectionState = "needs-sign-in";
      server.lastError = "Needs sign-in (oauth_unavailable).";
      throw new Error("fake-provider-response");
    });
    api.tools.mockImplementation(async ({ serverId }: { serverId: string }) => {
      const server = added.find((entry) => entry.id === serverId)!;
      server.connectionState = "needs-sign-in";
      server.lastError = "Needs sign-in (invalid_token).";
      throw new Error("rejected");
    });
    await openResults([
      listing("Either", "https://either.example.test/mcp", {
        type: "mixed",
        headerName: null,
        note: null,
      }),
      listing("Bearer", "https://bearer.example.test/mcp", bearer),
    ]);
    await click(resultConnect("Either")!);
    expect(container.textContent).not.toContain(
      "That token was not accepted. Check it and try again.",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
    await fill("Credential", "synthetic-token");
    await click(resultConnect("Either")!);
    const kept = added.find((entry) => entry.id === "created-1");
    expect(kept).toMatchObject({
      connectionState: "needs-sign-in",
      lastError: "Needs sign-in (invalid_token).",
    });
    expect(api.remove).not.toHaveBeenCalled();
    expect(api.update).toHaveBeenCalledWith({ id: "created-1", secret: "synthetic-token" });
    const either = resultBlock("Either");
    expect(either?.textContent).toContain("That token was not accepted. Check it and try again.");
    expect(container.textContent).not.toContain("Could not connect or load integrations.");
    expect(either?.querySelector<HTMLInputElement>('[aria-label="Credential"]')?.value).toBe(
      "synthetic-token",
    );

    await click(resultConnect("Bearer")!);
    await fill("Credential", "synthetic-bearer");
    await click(resultConnect("Bearer")!);
    expect(added.find((entry) => entry.id === "created-2")).toMatchObject({
      connectionState: "needs-sign-in",
      lastError: "Needs sign-in (invalid_token).",
    });
    expect(api.remove).not.toHaveBeenCalledWith({ id: "created-2" });
    expect(resultBlock("Bearer")?.textContent).toContain(
      "That token was not accepted. Check it and try again.",
    );
  });

  it("clears a load error after a poll or sign-in broadcast succeeds", async () => {
    const polls: Array<() => void> = [];
    const setInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation(((handler: () => void, ms?: number) => {
      if (ms !== 5000) return setInterval(handler, ms);
      polls.push(handler);
      return 0;
    }) as typeof window.setInterval);
    api.servers.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(container.textContent).toContain("Could not connect or load integrations.");
    api.servers.mockResolvedValue([
      customServer(
        "recovered",
        "Recovered server",
        "connected",
        "https://recovered.example.test/mcp",
      ),
    ]);
    await act(async () => polls[0]!());
    expect(container.textContent).toContain("Recovered server");
    expect(container.textContent).not.toContain("Could not connect or load integrations.");

    api.servers.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      broadcast.onmessage?.(new MessageEvent("message"));
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Could not connect or load integrations."),
    );
    api.servers.mockResolvedValue([
      customServer(
        "recovered",
        "Recovered server",
        "connected",
        "https://recovered.example.test/mcp",
      ),
    ]);
    await act(async () => {
      broadcast.onmessage?.(new MessageEvent("message"));
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Recovered server");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
  });
});

const publicResult = {
  domain: "figma.example.test",
  name: "Figma",
  description: "",
  pageUrl: null,
  surfaces: [
    {
      kind: "mcp" as const,
      slug: "figma",
      source: "https://mcp.figma.example.test/mcp",
      auth: null,
    },
  ],
};

const bearer = { type: "bearer", headerName: null, note: null };

function listing(name: string, source: string, auth: Record<string, unknown> | null = null) {
  const slug = name.toLowerCase().replaceAll(" ", "-");
  return {
    ...publicResult,
    domain: `${slug}.example.test`,
    name,
    surfaces: [{ kind: "mcp" as const, slug, source, auth }],
  };
}

async function openResults(results: unknown[]) {
  api.catalogSearch.mockResolvedValue({ enabled: true, results });
  await mount();
  await click(button("Find apps"));
  await fill("Search apps", "app");
  await click(button("Search integrations.sh"));
}

type ServerFixture = Record<string, unknown> & { id: string; connectionState: string };

/** A server list the API mocks keep in step: discovery and sign-in record "connected". */
function createdServers(initial: ServerFixture[] = []) {
  const servers = [...initial];
  let created = 0;
  api.servers.mockImplementation(async () => servers);
  api.create.mockImplementation(async (input: { name: string; endpoint: string }) => {
    created += 1;
    const server = {
      id: `created-${created}`,
      slug: `created-${created}`,
      name: input.name,
      description: "",
      endpoint: input.endpoint,
      transport: "streamable_http",
      enabled: true,
      oauthStatus: "none",
      connectionState: "not-connected",
      catalogId: null,
    };
    servers.push(server);
    return server;
  });
  const record = (serverId: string) => {
    const server = servers.find((entry) => entry.id === serverId);
    if (server) server.connectionState = "connected";
  };
  api.tools.mockImplementation(async ({ serverId }: { serverId: string }) => {
    record(serverId);
    return { capturedAt: "", serverVersion: null, account: null, tools: [] };
  });
  api.oauth.mockImplementation(async (serverId: string) => {
    record(serverId);
    return "connected";
  });
  api.remove.mockImplementation(async ({ id }: { id: string }) => {
    servers.splice(
      servers.findIndex((entry) => entry.id === id),
      1,
    );
    return { ok: true };
  });
  return servers;
}

function resultConnect(name: string) {
  const label = [...container.querySelectorAll("span")].find((node) => node.textContent === name);
  return [...(label?.parentElement?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent === "Connect",
  );
}

function resultBlock(name: string) {
  const label = [...container.querySelectorAll("span")].find((node) => node.textContent === name);
  return label?.parentElement?.parentElement ?? undefined;
}

function serverRow(name: string) {
  return [...container.querySelectorAll("tbody tr")].find((entry) =>
    entry.textContent?.includes(name),
  );
}

function remoteApp(id: string, name: string, endpoint: string): IntegrationDescriptor {
  return { ...catalog[0]!, id, name, vendor: id, endpoint };
}

function customServer(id: string, name: string, connectionState: string, endpoint?: string) {
  return {
    id,
    name,
    endpoint: endpoint ?? `https://${id}.example.test/mcp`,
    transport: "streamable_http",
    enabled: true,
    oauthStatus: "none",
    connectionState,
    catalogId: null,
  };
}

async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("token and destination controls", () => {
  it("submits a token through a password field, without an OAuth popup, then clears it", async () => {
    const github = {
      ...catalog[0]!,
      authKind: "token" as const,
      tokenUrl: "https://github.com/settings/personal-access-tokens/new",
    };
    api.list.mockImplementation(async () => ({ catalog: [github], connections }));
    api.connect.mockImplementation(async () => {
      connections = [connected];
      return { connection: connected, authorizationUrl: null, sessionId: null };
    });
    await mount();
    expect(container.textContent).not.toContain("Sign-in needs a pre-registered app");
    await click(button("Use a token"));
    expect(container.querySelector('[aria-label="Fine-grained token"]')?.getAttribute("type")).toBe(
      "password",
    );
    await fill("Fine-grained token", "synthetic-test-value");
    await click(button("Connect"));
    expect(api.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: "github",
        authKind: "token",
        token: "synthetic-test-value",
      }),
    );
    expect(window.open).not.toHaveBeenCalled();
    expect(api.consent).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("synthetic-test-value");
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
  it("shows optional GitHub sign-in only when configured and never sends app secrets", async () => {
    api.list.mockResolvedValue({
      catalog: [{ ...catalog[0]!, authKind: "token", oauthAvailable: true }],
      connections: [],
    });
    await mount();
    expect(button("Use a token")).toBeDefined();
    await click(button("Connect remote account"));
    expect(api.connect).toHaveBeenCalledWith({
      catalogId: "github",
      connectionId: undefined,
      host: undefined,
      authKind: "oauth",
      token: undefined,
    });
  });
  it.each([
    [
      "needs-client-registration",
      "This service needs client registration before you can connect.",
      "Connect",
    ],
    ["awaiting-consent", "Finish signing in in your browser.", "Cancel"],
    ["connected", "Connected", "Manage"],
    ["discovery-failed", "Could not load this account’s tools.", "Connect"],
    ["cancelled", "The connection was cancelled.", "Connect"],
  ] as const)(
    "renders Notion %s as one sentence and one action",
    async (state, sentence, action) => {
      api.list.mockResolvedValue({
        catalog: [{ ...catalog[0]!, id: "notion", name: "Notion", vendor: "notion" }],
        connections: [{ ...connected, catalogId: "notion", state }],
      });
      await mount();
      const card = container.querySelector('[data-testid="integration-notion"]')!;
      expect(card.querySelectorAll("p")).toHaveLength(state === "connected" ? 0 : 1);
      expect(card.textContent).toContain(sentence);
      expect(card.textContent).toContain(action);
      expect(card.querySelectorAll("button, a")).toHaveLength(1);
    },
  );
  it("normalizes a pasted Notion URL and saves its constraint", async () => {
    api.list.mockResolvedValue({
      catalog: [{ ...catalog[0]!, id: "notion", name: "Notion" }],
      connections: [{ ...connected, catalogId: "notion" }],
    });
    await mount();
    await click(button("Manage"));
    await fill("Notion page URL or ID", "https://www.notion.so/Notes-" + "a".repeat(32));
    await click(button("Save"));
    expect(api.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceConstraints: { notion: { parentId: "a".repeat(32), kind: "page" } },
      }),
    );
  });
  it("validates typed keys and uses only captured search identifiers in the picker", async () => {
    api.list.mockResolvedValue({
      catalog: [{ ...catalog[2]!, name: "Atlassian" }],
      connections: [{ ...connected, catalogId: "atlassian" }],
    });
    api.resourceTools.mockImplementation(async ({ kind }) =>
      kind === "jira"
        ? [
            {
              id: "synthetic_search_projects",
              description: "Search projects",
              fields: [{ name: "query", required: true }],
            },
          ]
        : [],
    );
    api.searchResources.mockResolvedValue([{ id: "DEMO", label: "Demo project", kind: "jira" }]);
    await mount();
    await click(button("Manage"));
    await fill("Jira project keys", "bad key");
    await click(button("Save"));
    expect(api.assign).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a valid destination");
    await fill("Jira project keys", "");
    await fill("query", "Demo");
    await click(button("Search"));
    await click(button("Demo project"));
    expect(api.searchResources).toHaveBeenCalledWith({
      connectionId: "connection",
      kind: "jira",
      toolId: "synthetic_search_projects",
      args: { query: "Demo" },
    });
    await fill("Confluence space keys or IDs", "DOCS");
    await click(button("Save"));
    expect(api.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceConstraints: { jiraProjects: ["DEMO"], confluenceSpaces: ["DOCS"] },
      }),
    );
  });
});

async function permission(tool: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(
    `[aria-label="Permission for ${tool}"]`,
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
