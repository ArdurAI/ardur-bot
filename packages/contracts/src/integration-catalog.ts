import { z } from "zod";

const PublicUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "Use an HTTPS URL without credentials, query parameters or fragments");

export const IntegrationDescriptorSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    vendor: z.string().min(1),
    available: z.boolean(),
    transport: z.enum(["remote-http", "stdio"]),
    endpoint: PublicUrl.optional(),
    launch: z
      .object({ command: z.string().min(1), args: z.array(z.string()) })
      .strict()
      .optional(),
    authKind: z.enum(["oauth", "token"]),
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
    if (!descriptor.available) return;
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

export const IntegrationStateSchema = z.enum([
  "not-connected",
  "awaiting-consent",
  "connected",
  "discovery-failed",
  "cancelled",
  "needs-client-registration",
]);
export const IntegrationConnectionSchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  state: IntegrationStateSchema,
  manifest: IntegrationManifestSchema.nullable(),
  needsReview: z.boolean(),
});
export type IntegrationConnection = z.infer<typeof IntegrationConnectionSchema>;
export const IntegrationGrantSchema = z.object({
  botId: z.string(),
  toolIds: z.array(z.string()),
  needsReview: z.boolean(),
});
export type IntegrationGrant = z.infer<typeof IntegrationGrantSchema>;
