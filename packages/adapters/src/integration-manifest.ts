import { createHash } from "node:crypto";
import type { IntegrationManifest } from "@ardurbot/contracts";
import { IntegrationManifestSchema } from "@ardurbot/contracts";
import { sanitizeConnectorError } from "./connector-safety.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function inputSchemaDigest(schema: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(schema)))
    .digest("hex");
}

export function captureIntegrationManifest(
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>,
  serverVersion: string | null,
  secrets: string[] = [],
  capturedAt = new Date().toISOString(),
): IntegrationManifest {
  const clean = (text: string) =>
    sanitizeConnectorError(text, secrets)
      .replace(/https?:\/\/[^\s)]+/gi, "[link]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[account]");
  const ids = new Set<string>();
  const manifest = IntegrationManifestSchema.parse({
    capturedAt,
    account: null,
    serverVersion: serverVersion ? clean(serverVersion) : null,
    tools: tools.map((tool) => {
      // Never alter an identifier: reject it if it contains credential material.
      if (ids.has(tool.name) || clean(tool.name) !== tool.name)
        throw new Error("Invalid tool manifest.");
      ids.add(tool.name);
      return {
        id: tool.name,
        description: clean(tool.description ?? ""),
        inputSchemaDigest: inputSchemaDigest(tool.inputSchema),
      };
    }),
  });
  return manifest;
}
