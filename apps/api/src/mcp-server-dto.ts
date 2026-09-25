import type { McpServer } from "@ardurbot/contracts";
import { SpaceToolPoliciesSchema } from "@ardurbot/contracts";
import { ImportedProvenanceSchema } from "@ardurbot/contracts/local-import";
import { redactMcpArguments } from "@ardurbot/host-runtime/mcp-diagnostics";

export function mcpServerDto(
  row: {
    imported?: unknown;
    catalogId?: string | null;
    spaceToolPolicies?: unknown;
    managedBy?: string | null;
    managedId?: string | null;
    placement?: string;
    connectionState?: string;
    lastError?: string | null;
    id: string;
    spaceId: string;
    slug: string;
    name: string;
    description: string;
    transport: string;
    endpoint: string | null;
    command: string | null;
    args: unknown;
    env: unknown;
    headers: unknown;
    secretId: string | null;
    enabled: boolean;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  },
  oauthStatus: McpServer["oauthStatus"] = "none",
): McpServer {
  const args = Array.isArray(row.args)
    ? row.args.filter((item): item is string => typeof item === "string")
    : [];
  const envKeys =
    row.env && typeof row.env === "object" && !Array.isArray(row.env) ? Object.keys(row.env) : [];
  const headerKeys =
    row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)
      ? Object.entries(row.headers)
          .filter(([, value]) => !row.imported || !value || typeof value !== "object")
          .map(([key]) => key)
      : [];
  return {
    spaceToolPolicies: SpaceToolPoliciesSchema.safeParse(row.spaceToolPolicies).data ?? {},
    catalogId: row.catalogId ?? null,
    id: row.id,
    spaceId: row.spaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport as McpServer["transport"],
    endpoint: row.endpoint,
    command: row.command,
    args: redactMcpArguments(args),
    managedBy: row.managedBy === "extension" || row.managedBy === "plugin" ? row.managedBy : null,
    managedId: row.managedId ?? null,
    placement: row.placement === "host" ? "host" : "worker",
    connectionState: row.connectionState ?? "not-connected",
    lastError: row.lastError ?? null,
    envKeys,
    headerKeys,
    hasSecret: row.secretId !== null,
    ...(row.imported ? { imported: ImportedProvenanceSchema.parse(row.imported) } : {}),
    oauthStatus,
    enabled: row.enabled,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
