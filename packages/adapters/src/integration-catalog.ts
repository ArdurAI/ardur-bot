import type { IntegrationDescriptor } from "@ardurbot/contracts";
import { hostIntegration, IntegrationDescriptorSchema } from "@ardurbot/contracts";

const common = {
  transport: "remote-http",
  authKind: "oauth",
  requiredInputs: [],
  verifiedAt: "2026-09-24",
  serverVersion: null,
  placement: "backend",
  defaultAllowedTools: [],
  toolPolicies: {},
} as const;

export function validateIntegrationDescriptor(value: unknown): IntegrationDescriptor {
  return IntegrationDescriptorSchema.parse(value);
}

export const integrationCatalog: readonly IntegrationDescriptor[] = [
  {
    ...common,
    id: "github",
    name: "GitHub",
    vendor: "github",
    authKind: "token",
    tokenUrl: "https://github.com/settings/personal-access-tokens/new",
    oauthApp: {
      clientIdEnv: "GITHUB_MCP_CLIENT_ID",
      clientSecretEnv: "GITHUB_MCP_CLIENT_SECRET",
    },
    available: true,
    riskClass: "collaboration",
    endpoint: "https://api.githubcopilot.com/mcp/",
    docsUrl:
      "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server",
  },
  {
    ...common,
    id: "gitlab",
    name: "GitLab",
    vendor: "gitlab",
    available: true,
    riskClass: "collaboration",
    endpoint: "https://gitlab.com/api/v4/mcp",
    requiredInputs: [{ id: "host", type: "url", required: false, advanced: true }],
    docsUrl: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
  },
  {
    ...common,
    id: "atlassian",
    name: "Atlassian",
    vendor: "atlassian",
    available: true,
    riskClass: "collaboration",
    endpoint: "https://mcp.atlassian.com/v2/mcp?tools=all",
    docsUrl:
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
  },
  {
    ...common,
    id: "notion",
    name: "Notion",
    vendor: "notion",
    available: true,
    riskClass: "collaboration",
    endpoint: "https://mcp.notion.com/mcp",
    apiVersion: "2026-03-11",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
  {
    ...common,
    id: "linear",
    name: "Linear",
    vendor: "linear",
    available: true,
    riskClass: "collaboration",
    endpoint: "https://mcp.linear.app/mcp",
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    ...common,
    id: "aws",
    name: "AWS",
    vendor: "aws",
    available: true,
    riskClass: "infrastructure",
    endpoint: "https://aws-mcp.us-east-1.api.aws/mcp?oauth=initialize",
    docsUrl: "https://docs.aws.amazon.com/agent-toolkit/latest/userguide/oauth-authentication.html",
  },
  ...[
    ["jenkins", "Jenkins", "https://www.jenkins.io/doc/"],
    ["kubernetes", "Kubernetes", "https://kubernetes.io/docs/"],
    ["google-cloud", "Google Cloud", "https://cloud.google.com/docs"],
    ["azure", "Azure", "https://learn.microsoft.com/azure/"],
  ].map(([id, name, docsUrl]) => ({
    ...common,
    id,
    name,
    vendor: id,
    docsUrl,
    available: true,
    transport: "host-cli",
    placement: "computer-runner",
    riskClass: "infrastructure",
    ...(id === "azure"
      ? { remoteDocsUrl: "https://learn.microsoft.com/azure/developer/azure-mcp-server/overview" }
      : {}),
  })),
].map((entry) => {
  const host = hostIntegration(entry.id!);
  return validateIntegrationDescriptor({
    ...entry,
    ...(host ? { hostCli: { command: host.command, installUrl: host.installUrl } } : {}),
  });
});

export function integrationById(id: string): IntegrationDescriptor | undefined {
  return integrationCatalog.find((entry) => entry.id === id);
}

export function connectableIntegration(id: string, host?: string): IntegrationDescriptor {
  const descriptor = integrationById(id);
  if (!descriptor?.available) throw new Error("This integration is not available yet.");
  if (!host) return validateIntegrationDescriptor(descriptor);
  if (id === "azure")
    return validateIntegrationDescriptor({
      ...descriptor,
      transport: "remote-http",
      placement: "backend",
      endpoint: host,
    });
  if (id !== "gitlab") throw new Error("This integration does not support a custom host.");
  const url = new URL(host);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Enter the HTTPS host without a path or credentials.");
  }
  return validateIntegrationDescriptor({ ...descriptor, endpoint: `${url.origin}/api/v4/mcp` });
}
