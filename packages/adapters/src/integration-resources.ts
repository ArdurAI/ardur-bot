import type {
  IntegrationManifest,
  IntegrationResourceChoice,
  IntegrationResourceKind,
  IntegrationResourceTool,
} from "@ardurbot/contracts";
import { notionResourceId } from "@ardurbot/contracts";
import { integrationToolKind } from "@ardurbot/core";
import { inputSchemaDigest } from "./integration-manifest.js";

type LiveTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

/** Only captured read/list/search tools with a simple, inspectable string form are offered. */
export function resourceSearchTools(
  catalogId: string | null,
  kind: IntegrationResourceKind,
  manifest: IntegrationManifest,
  live: LiveTool[],
): IntegrationResourceTool[] {
  if (catalogId !== (kind === "notion" ? "notion" : "atlassian")) return [];
  return live.flatMap((tool) => {
    const captured = manifest.tools.find((entry) => entry.id === tool.name);
    if (
      !captured ||
      captured.inputSchemaDigest !== inputSchemaDigest(tool.inputSchema) ||
      integrationToolKind(captured.id, captured.description) !== "read" ||
      tool.annotations?.readOnlyHint === false ||
      !/search|list|find/i.test(captured.id)
    )
      return [];
    const text = `${captured.id} ${captured.description}`;
    if (
      !(kind === "notion" ? /page|database|search/i : kind === "jira" ? /project/i : /space/i).test(
        text,
      )
    )
      return [];
    const properties = record(tool.inputSchema.properties);
    const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
    if (
      tool.inputSchema.oneOf ||
      tool.inputSchema.anyOf ||
      tool.inputSchema.allOf ||
      required.some((key) => typeof key !== "string" || record(properties[key]).type !== "string")
    )
      return [];
    const fields = Object.entries(properties).flatMap(([name, schema]) => {
      if (record(schema).type !== "string" || /secret|token|password|authorization/i.test(name))
        return [];
      return [{ name, required: required.includes(name) }];
    });
    if (required.some((name) => !fields.some((field) => field.name === name))) return [];
    return [{ id: captured.id, description: captured.description, fields }];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reduce provider responses to bounded picker choices; never return raw responses or URLs. */
export function resourceChoices(
  kind: IntegrationResourceKind,
  payload: unknown,
): IntegrationResourceChoice[] {
  const choices = new Map<string, IntegrationResourceChoice>();
  let visited = 0;
  function visit(value: unknown, depth: number) {
    if (depth > 12 || ++visited > 5000 || choices.size >= 100) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const row = record(value);
    if (row.type === "text" && typeof row.text === "string" && row.text.length < 500_000) {
      try {
        visit(JSON.parse(row.text), depth + 1);
      } catch {
        /* Plain prose is not a resource. */
      }
    }
    const id =
      kind === "notion"
        ? typeof row.id === "string"
          ? notionResourceId(row.id)
          : undefined
        : kind === "confluence" && (typeof row.id === "string" || typeof row.id === "number")
          ? String(row.id)
          : typeof row.key === "string"
            ? row.key
            : undefined;
    const resourceKind = kind === "notion" ? (row.object ?? row.type) : kind;
    if (
      id &&
      (kind !== "notion" || resourceKind === "page" || resourceKind === "database") &&
      (kind !== "jira" || /^[A-Z][A-Z0-9_]{0,254}$/.test(id)) &&
      (kind !== "confluence" || /^[A-Za-z0-9][A-Za-z0-9_~-]{0,254}$/.test(id))
    ) {
      const title =
        typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : id;
      choices.set(id, {
        id,
        kind: resourceKind as IntegrationResourceChoice["kind"],
        label: title.slice(0, 160),
      });
    }
    for (const [key, item] of Object.entries(row)) {
      if (!/secret|token|password|authorization/i.test(key) && typeof item === "object")
        visit(item, depth + 1);
    }
  }
  visit(payload, 0);
  return [...choices.values()];
}
