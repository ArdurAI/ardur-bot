import { IntegrationResourceConstraintsSchema, notionResourceId } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { captureIntegrationManifest } from "./integration-manifest.js";
import { resourceChoices, resourceSearchTools } from "./integration-resources.js";

const live = [
  {
    name: "synthetic_search_pages",
    description: "Search pages in a synthetic service.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];
const manifest = captureIntegrationManifest(live, null);
describe("resource discovery", () => {
  it("offers captured runtime identifiers with their actual required fields", () => {
    expect(resourceSearchTools("notion", "notion", manifest, live)).toEqual([
      {
        id: live[0]!.name,
        description: live[0]!.description,
        fields: [{ name: "query", required: true }],
      },
    ]);
    expect(resourceSearchTools("github", "notion", manifest, live)).toEqual([]);
    expect(resourceSearchTools("notion", "notion", { ...manifest, tools: [] }, live)).toEqual([]);
    expect(
      resourceSearchTools("notion", "notion", manifest, [{ ...live[0]!, inputSchema: {} }]),
    ).toEqual([]);
    expect(
      resourceSearchTools("notion", "notion", manifest, [
        { ...live[0]!, annotations: { readOnlyHint: false } },
      ]),
    ).toEqual([]);
  });
  it("does not treat a mutation or unsupported required parameters as a picker", () => {
    for (const tool of [
      { ...live[0]!, name: "synthetic_search_and_delete", description: "Search and delete pages" },
      {
        ...live[0]!,
        inputSchema: {
          type: "object",
          properties: { unsafe: { type: "object" } },
          required: ["unsafe"],
        },
      },
    ])
      expect(
        resourceSearchTools("notion", "notion", captureIntegrationManifest([tool], null), [tool]),
      ).toEqual([]);
  });
  it("extracts only resource identities from structured and text responses", () => {
    expect(
      resourceChoices("notion", {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              results: [{ id: "a".repeat(32), object: "page", title: "Notes", token: "unused" }],
            }),
          },
        ],
      }),
    ).toEqual([{ id: "a".repeat(32), kind: "page", label: "Notes" }]);
    expect(
      resourceChoices("jira", {
        projects: [{ id: "123", key: "DEMO", name: "Demo" }, { key: "bad key" }],
      }),
    ).toEqual([{ id: "DEMO", label: "Demo", kind: "jira" }]);
    expect(resourceChoices("confluence", { results: [{ key: "DOCS", name: "Docs" }] })).toEqual([
      { id: "DOCS", label: "Docs", kind: "confluence" },
    ]);
    expect(
      resourceChoices("notion", { content: [{ type: "text", text: "not a result" }] }),
    ).toEqual([]);
  });
  it("validates canonical Notion IDs/URLs and typed project/space keys", () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    expect(notionResourceId(id)).toBe(id.replaceAll("-", ""));
    expect(notionResourceId(`https://www.notion.so/Notes-${id.replaceAll("-", "")}?v=view`)).toBe(
      id.replaceAll("-", ""),
    );
    for (const value of [
      "bad",
      "https://evil.test/" + id,
      "https://notion.so.evil.test/" + id,
      "http://notion.so/" + id,
      "https://user:pass@notion.so/" + id,
    ])
      expect(notionResourceId(value)).toBeUndefined();
    expect(
      IntegrationResourceConstraintsSchema.safeParse({ jiraProjects: ["bad key"] }).success,
    ).toBe(false);
    expect(
      IntegrationResourceConstraintsSchema.safeParse({ confluenceSpaces: ["DOCS"] }).success,
    ).toBe(true);
  });
});

it("keeps the discovered Confluence space ID for tools that require IDs", () => {
  expect(
    resourceChoices("confluence", { results: [{ id: "12345", key: "DOCS", name: "Docs" }] }),
  ).toEqual([{ id: "12345", label: "Docs", kind: "confluence" }]);
});
