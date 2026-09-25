import { z } from "zod";
import { HostIntegrationSchema } from "./host-integrations.js";

const PublicUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "Use an HTTPS URL without credentials, query parameters or fragments");

const McpEndpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      [...url.searchParams].every(
        ([key, value]) =>
          (key === "tools" && value === "all") || (key === "oauth" && value === "initialize"),
      )
    );
  }, "Use an HTTPS MCP URL without credentials or private query parameters");

export const IntegrationDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    vendor: z.string().min(1),
    available: z.boolean(),
    transport: z.enum(["remote-http", "stdio", "host-cli"]),
    hostCli: z.object({ command: z.string(), installUrl: PublicUrl }).optional(),
    remoteDocsUrl: PublicUrl.optional(),
    endpoint: McpEndpoint.optional(),
    launch: z
      .object({ command: z.string().min(1), args: z.array(z.string()) })
      .strict()
      .optional(),
    authKind: z.enum(["oauth", "token"]),
    tokenUrl: PublicUrl.optional(),
    oauthApp: z
      .object({
        clientIdEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
        clientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
      })
      .strict()
      .optional(),
    oauthAvailable: z.boolean().optional(),
    apiVersion: z.string().optional(),
    // Definitions only: credential values belong in the encrypted secret store.
    requiredInputs: z.array(
      z
        .object({
          id: z.string().min(1),
          type: z.enum(["string", "url", "boolean", "number", "secret-reference"]),
          required: z.boolean(),
          advanced: z.boolean().default(false),
        })
        .strict(),
    ),
    docsUrl: PublicUrl,
    verifiedAt: z.iso.date(),
    serverVersion: z.string().nullable(),
    placement: z.enum(["backend", "computer-runner"]),
    riskClass: z.enum(["collaboration", "infrastructure"]),
    defaultAllowedTools: z.array(z.string().min(1)),
    toolPolicies: z.record(
      z.string(),
      z
        .object({
          approval: z.enum(["ask-first", "allow", "disabled"]),
          risk: z.enum(["reviewed-read", "write", "unknown"]),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    if (!descriptor.available || descriptor.transport === "host-cli") return;
    if (
      descriptor.transport === "remote-http"
        ? !descriptor.endpoint || descriptor.launch
        : !descriptor.launch || descriptor.endpoint
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Specify exactly one endpoint or launch for the transport",
      });
    }
  });
export type IntegrationDescriptor = z.infer<typeof IntegrationDescriptorSchema>;

export const IntegrationManifestSchema = z
  .object({
    capturedAt: z.iso.datetime(),
    serverVersion: z.string().nullable(),
    account: z.string().nullable(),
    workspace: z.string().nullable().optional(),
    scopes: z.array(z.string()).optional(),
    tools: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            description: z.string().max(8000),
            inputSchemaDigest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export type IntegrationManifest = z.infer<typeof IntegrationManifestSchema>;

export const SpaceToolPoliciesSchema = z
  .record(z.string().min(1).max(200), z.enum(["ask-first", "allow"]))
  .refine((policies) => Object.keys(policies).length <= 2000, "Too many tool policies");
export type SpaceToolPolicies = z.infer<typeof SpaceToolPoliciesSchema>;

export const IntegrationResourceConstraintsSchema = z
  .object({
    notion: z
      .object({
        parentId: z.string().regex(/^[a-f0-9]{32}$/),
        kind: z.enum(["page", "database"]),
      })
      .strict()
      .optional(),
    jiraProjects: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,254}$/))
      .max(100)
      .optional(),
    confluenceSpaces: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_~-]{0,254}$/))
      .max(100)
      .optional(),
  })
  .strict();
export type IntegrationResourceConstraints = z.infer<typeof IntegrationResourceConstraintsSchema>;

export const IntegrationResourceKindSchema = z.enum(["notion", "jira", "confluence"]);
export type IntegrationResourceKind = z.infer<typeof IntegrationResourceKindSchema>;
export const IntegrationResourceToolSchema = z.object({
  id: z.string(),
  description: z.string(),
  fields: z.array(z.object({ name: z.string(), required: z.boolean() })),
});
export type IntegrationResourceTool = z.infer<typeof IntegrationResourceToolSchema>;
export const IntegrationResourceChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["page", "database", "jira", "confluence"]),
});
export type IntegrationResourceChoice = z.infer<typeof IntegrationResourceChoiceSchema>;

/** Accept only Notion identifiers or canonical Notion page URLs, never arbitrary hosts. */
export function notionResourceId(value: string): string | undefined {
  let candidate = value.trim();
  if (/^https?:/i.test(candidate)) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        (!["notion.so", "www.notion.so", "notion.site"].includes(url.hostname) &&
          !url.hostname.endsWith(".notion.site"))
      )
        return undefined;
      candidate = url.pathname.split("/").filter(Boolean).pop() ?? "";
      candidate =
        candidate.match(
          /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i,
        )?.[0] ?? "";
    } catch {
      return undefined;
    }
  }
  if (
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(
      candidate,
    )
  )
    return undefined;
  return candidate.replaceAll("-", "").toLowerCase();
}

export const IntegrationStateSchema = z.enum([
  "not-connected",
  "awaiting-consent",
  "connected",
  "discovery-failed",
  "cancelled",
  "needs-client-registration",
  "needs-sign-in",
]);
export const IntegrationConnectionSchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  state: IntegrationStateSchema,
  manifest: IntegrationManifestSchema.nullable(),
  needsReview: z.boolean(),
  resourceConstraints: IntegrationResourceConstraintsSchema.optional(),
  spaceToolPolicies: SpaceToolPoliciesSchema.default({}),
  transport: z.string().optional(),
  consentStartedAt: z.iso.datetime().nullable().optional(),
  lastCheckedAt: z.iso.datetime().nullable().optional(),
  lastSuccessAt: z.iso.datetime().nullable().optional(),
  lastUsedAt: z.iso.datetime().nullable().optional(),
  lastError: z.string().nullable().optional(),
  recentErrors: z.array(z.object({ at: z.iso.datetime(), message: z.string() })).optional(),
});
export type IntegrationConnection = z.infer<typeof IntegrationConnectionSchema>;
export const IntegrationGrantSchema = z.object({
  botId: z.string(),
  toolIds: z.array(z.string()),
  needsReview: z.boolean(),
});
export type IntegrationGrant = z.infer<typeof IntegrationGrantSchema>;

export const IntegrationCatalogListSchema = z.object({
  catalog: z.array(IntegrationDescriptorSchema),
  connections: z.array(IntegrationConnectionSchema),
  webUrl: z.string().url().optional(),
  hostSignIns: z.array(HostIntegrationSchema).optional(),
});
export type IntegrationCatalogList = z.infer<typeof IntegrationCatalogListSchema>;
