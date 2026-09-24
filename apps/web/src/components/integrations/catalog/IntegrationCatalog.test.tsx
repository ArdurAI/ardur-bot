// @vitest-environment jsdom
import type { IntegrationConnection, IntegrationDescriptor } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationCatalog } from "./IntegrationCatalog";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  connect: vi.fn(),
  grants: vi.fn(),
  assign: vi.fn(),
  revoke: vi.fn(),
  cancel: vi.fn(),
  bots: vi.fn(),
  consent: vi.fn(),
  resourceTools: vi.fn(),
  searchResources: vi.fn(),
}));
vi.mock("../../../lib/rpc", () => ({
  selectedSpaceId: () => "space",
  rpc: { integrations: api, bots: { list: api.bots } },
}));
vi.mock("../../../lib/mcp-connect", () => ({
  MCP_OAUTH_CHANNEL: "test",
  waitForMcpOauth: api.consent,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
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
  available: index < 3,
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
beforeEach(() => {
  vi.clearAllMocks();
  connections = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null;
      close() {}
    },
  );
  vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
  api.list.mockImplementation(async () => ({ catalog, connections }));
  api.bots.mockResolvedValue([{ id: "bot", name: "Helper", archivedAt: null }]);
  api.grants.mockResolvedValue([]);
  api.resourceTools.mockResolvedValue([]);
  api.searchResources.mockResolvedValue([]);
  api.assign.mockImplementation(async (input) =>
    input.botIds.map((botId: string) => ({ botId, toolIds: input.toolIds, needsReview: false })),
  );
  api.connect.mockImplementation(async () => {
    connections = [connected];
    return {
      connection: connected,
      authorizationUrl: "https://example.test/authorize",
      sessionId: "session",
    };
  });
  api.consent.mockResolvedValue("connected");
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
  it("shows eight cards, three connect actions and five unavailable integrations", async () => {
    await mount();
    expect(container.querySelectorAll('[data-testid^="integration-"]')).toHaveLength(9);
    expect(
      [...container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Connect",
      ),
    ).toHaveLength(3);
    expect(container.textContent?.match(/Coming soon/g)).toHaveLength(5);
    expect(container.querySelector('[aria-label="GitLab host"]')).toBeNull();
    expect(container.textContent).not.toContain("api.githubcopilot");
  });
  it("connects, starts with no grants, then saves only the selected bots and tools", async () => {
    await mount();
    await click(button("Connect", container.querySelector('[data-testid="integration-github"]')!));
    expect(api.connect).toHaveBeenCalledWith({
      catalogId: "github",
      connectionId: undefined,
      host: undefined,
    });
    expect(api.consent).toHaveBeenCalledWith(
      "https://example.test/authorize",
      expect.anything(),
      "session",
    );
    expect(api.assign).not.toHaveBeenCalled();
    const checks = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checks).toHaveLength(3);
    expect(checks.every((input) => !input.checked)).toBe(true);
    expect(container.textContent?.match(/asks first/g)).toHaveLength(1);
    await click(container.querySelector('[aria-label="Helper"]')!);
    await click(container.querySelector('[aria-label="synthetic_update"]')!);
    await click(button("Save"));
    expect(api.assign).toHaveBeenCalledWith({
      connectionId: "connection",
      botIds: ["bot"],
      toolIds: ["synthetic_update"],
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
      container.querySelector<HTMLButtonElement>('[aria-label="Approval for synthetic_read"]')!;
    expect(approval().textContent).toBe("Allow");
    await click(approval());
    expect(approval().textContent).toBe("Ask first");
    await click(button("Save"));
    expect(api.assign).toHaveBeenCalledWith({
      connectionId: "connection",
      botIds: ["bot"],
      toolIds: ["synthetic_read"],
      spaceToolPolicies: { synthetic_read: "ask-first" },
    });
    await click(button("Back"));
    await click(button("Manage"));
    expect(approval().textContent).toBe("Ask first");
  });
  it("shows registration help and review state with one primary action", async () => {
    connections = [
      { ...connected, state: "needs-client-registration" },
      { ...connected, id: "gitlab", catalogId: "gitlab", needsReview: true },
    ];
    await mount();
    const github = container.querySelector('[data-testid="integration-github"]')!;
    expect(github.textContent).toContain("needs client registration");
    expect(github.querySelector("a")?.href).toBe("https://example.test/docs");
    expect(github.textContent).not.toContain("Connect your account");
    expect(button("Review tools")).toBeDefined();
  });
  it("shows a pending consent sentence and allows cancellation while the browser is open", async () => {
    let finishConsent: (result: string) => void = () => {};
    api.connect.mockResolvedValue({
      connection: { ...connected, state: "awaiting-consent", manifest: null },
      authorizationUrl: "https://example.test/authorize",
      sessionId: "session",
    });
    api.consent.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishConsent = resolve;
        }),
    );
    await mount();
    await click(button("Connect"));
    expect(container.textContent).toContain("Finish signing in in your browser.");
    expect(button("Cancel").disabled).toBe(false);
    await click(button("Cancel"));
    expect(api.cancel).toHaveBeenCalledWith({ connectionId: "connection" });
    await act(async () => finishConsent("cancelled"));
  });

  it("cancels abandoned consent and surfaces load errors without provider text", async () => {
    api.consent.mockResolvedValue("cancelled");
    await mount();
    await click(button("Connect"));
    expect(api.cancel).toHaveBeenCalledWith({ connectionId: "connection" });
    await act(async () => root.unmount());
    root = createRoot(container);
    api.list.mockRejectedValueOnce(new Error("fake-sensitive-provider-response"));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not connect or load integrations.",
    );
    expect(container.textContent).not.toContain("fake-sensitive");
    expect(button("Try again")).toBeDefined();
  });
});

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
    expect(container.textContent).toContain(
      "Sign-in needs a pre-registered app; use a fine-grained token instead.",
    );
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
    await click(button("Sign in with GitHub"));
    expect(api.connect).toHaveBeenCalledWith({
      catalogId: "github",
      connectionId: undefined,
      host: undefined,
      authKind: "oauth",
    });
    expect(api.consent).toHaveBeenCalled();
  });
  it.each([
    [
      "needs-client-registration",
      "This service needs client registration before you can connect.",
      "Open documentation",
    ],
    ["awaiting-consent", "Finish signing in in your browser.", "Cancel"],
    ["connected", "Your account is connected.", "Manage"],
    ["discovery-failed", "Could not load this account’s tools.", "Try again"],
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
      expect(card.querySelectorAll("p")).toHaveLength(1);
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
