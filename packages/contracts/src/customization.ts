import { oc } from "@orpc/contract";
import * as z from "zod";
import { McpServerConfigInput, McpServerSchema } from "./domain.js";

const id = z.string().min(1).max(160);
const ok = z.object({ ok: z.literal(true) });
export const McpDiagnosticsSchema = z.object({
  status: z.enum(["running", "stopped", "error"]),
  lastError: z.string().nullable(),
  lines: z.array(z.string().max(4096)).max(200),
  updatedAt: z.string().nullable(),
});
export type McpDiagnostics = z.infer<typeof McpDiagnosticsSchema>;

export const LocalServerConfigSchema = z.strictObject({
  mcpServers: z
    .record(
      z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
      McpServerConfigInput.options[2].omit({ slug: true, transport: true, clearCredential: true }),
    )
    .refine((servers) => Object.keys(servers).length <= 100),
});
export type LocalServerConfig = z.infer<typeof LocalServerConfigSchema>;
export const ConfigChangeSchema = z.object({
  name: z.string(),
  action: z.enum(["add", "change", "remove"]),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export const CustomizationSkillSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  kind: z.enum(["file", "taught", "learned"]),
  source: z.string(),
  enabled: z.boolean(),
  botId: z.string().nullable(),
  pluginId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  content: z.string().optional(),
});
export type CustomizationSkill = z.infer<typeof CustomizationSkillSchema>;
export const CustomizationCatalogSchema = z.object({
  version: z.literal(1),
  skills: z.array(
    z.object({ id, name: z.string(), description: z.string(), categories: z.array(z.string()) }),
  ),
  plugins: z.array(
    z.object({
      id,
      name: z.string(),
      description: z.string(),
      version: z.string(),
      categories: z.array(z.string()),
    }),
  ),
});
export const PluginSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  author: z.string().nullable(),
  skills: z.array(z.string()),
  commands: z.array(z.string()),
  servers: z.array(z.string()),
  instructions: z.array(z.string()),
});
export type PluginSummary = z.infer<typeof PluginSummarySchema>;
export const PluginInstallSchema = PluginSummarySchema.extend({
  state: z.enum(["installing", "installed", "removing"]).default("installed"),
  id,
  marketplaceId: z.string().nullable(),
  source: z.enum(["catalog", "marketplace", "space"]),
  createdAt: z.string(),
  categories: z.array(z.string()),
});
export type PluginInstall = z.infer<typeof PluginInstallSchema>;
export const MarketplaceSchema = z.object({
  id,
  name: z.string(),
  source: z.string(),
  plugins: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      author: z.string().nullable(),
      categories: z.array(z.string()),
    }),
  ),
});
export const BundleUploadSchema = z
  .array(
    z.strictObject({
      path: z.string().min(1).max(1024),
      content: z.string().max(12_000_000),
      executable: z.boolean().optional(),
    }),
  )
  .max(1000)
  .refine((files) => files.reduce((size, file) => size + file.content.length, 0) <= 12_000_000);
export const ManagedServerInputSchema = z
  .strictObject({
    secretValues: z.array(z.string().max(4096)).max(256).default([]),
    managedId: id,
    managedBy: z.enum(["extension", "plugin"]),
    name: z.string().min(1).max(120),
    description: z.string().max(2000),
    placement: z.enum(["host", "worker"]),
    command: z.string().min(1).max(512),
    args: z.array(z.string().max(2048)).max(64),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)),
    cwd: z.string().min(1).max(4096),
  })
  .refine((value) => Object.keys(value.env).length <= 64);

export const customizationContract = {
  connectors: {
    summary: oc.output(z.object({ needingReconnection: z.number().int().nonnegative() })),
  },
  developer: {
    list: oc.output(z.array(McpServerSchema)),
    logs: oc.input(z.object({ serverId: id })).output(McpDiagnosticsSchema),
    config: oc.output(z.object({ json: z.string(), revision: z.string() })),
    preview: oc
      .input(z.object({ json: z.string().max(256_000), revision: z.string() }))
      .output(z.object({ id, changes: z.array(ConfigChangeSchema) })),
    apply: oc
      .input(z.object({ previewId: id, placement: z.enum(["host", "worker"]).default("worker") }))
      .output(ok),
  },
  extensions: {
    context: oc.output(z.object({ userId: id, spaceId: id })),
    register: oc
      .input(ManagedServerInputSchema)
      .output(
        z.object({ serverId: id, revision: z.number().int().positive(), userId: id, spaceId: id }),
      ),
    remove: oc
      .input(z.object({ managedId: id, managedBy: z.enum(["extension", "plugin"]) }))
      .output(ok),
  },
  customizationSkills: {
    list: oc.output(z.array(CustomizationSkillSchema)),
    get: oc
      .input(z.object({ id, kind: z.enum(["file", "taught", "learned"]) }))
      .output(CustomizationSkillSchema),
    setEnabled: oc
      .input(z.object({ id, kind: z.enum(["file", "taught", "learned"]), enabled: z.boolean() }))
      .output(ok),
    remove: oc.input(z.object({ id, kind: z.enum(["file", "taught", "learned"]) })).output(ok),
    import: oc
      .input(
        z
          .object({
            files: BundleUploadSchema.optional(),
            zip: z.string().max(12_000_000).optional(),
          })
          .refine((v) => Boolean(v.files) !== Boolean(v.zip)),
      )
      .output(z.array(CustomizationSkillSchema)),
    catalog: oc.output(CustomizationCatalogSchema),
  },
  plugins: {
    list: oc.output(
      z.object({
        installs: z.array(PluginInstallSchema),
        marketplaces: z.array(MarketplaceSchema),
      }),
    ),
    addMarketplace: oc
      .input(
        z
          .object({ url: z.string().max(2048).optional(), files: BundleUploadSchema.optional() })
          .refine((v) => Boolean(v.url) !== Boolean(v.files)),
      )
      .output(MarketplaceSchema),
    removeMarketplace: oc.input(z.object({ id })).output(ok),
    preview: oc
      .input(
        z.object({
          name: z.string().min(1).max(120),
          marketplaceId: id.optional(),
          catalogId: id.optional(),
        }),
      )
      .output(z.object({ id, summary: PluginSummarySchema })),
    files: oc.input(z.object({ previewId: id })).output(BundleUploadSchema),
    install: oc
      .input(
        z.object({
          previewId: id,
          nativeRoot: z.string().max(4096).optional(),
          placement: z.enum(["host", "worker"]).default("worker"),
          installationId: z.string().uuid().optional(),
        }),
      )
      .output(PluginInstallSchema),
    uninstall: oc.input(z.object({ id })).output(ok),
  },
};
