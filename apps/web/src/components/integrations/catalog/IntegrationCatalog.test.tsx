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
}));
vi.mock("../../../lib/rpc", () => ({ rpc: { integrations: api, bots: { list: api.bots } } }));
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
    expect(container.textContent?.match(/asks first/g)).toHaveLength(2);
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
