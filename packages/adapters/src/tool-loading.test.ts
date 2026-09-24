import type { ConnectorTool } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  catalogEntries,
  executeLazyCatalogControl,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";

const fortyToolFixture: ConnectorTool[] = Array.from({ length: 40 }, (_, i) => ({
  name: `notes_${i}`,
  description: `Read note collection ${i}.`,
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Array.from({ length: 12 }, (_, field) => [
        `filter_${field}`,
        {
          type: "string",
          description: `An optional exact filter for note metadata field ${field}.`,
          maxLength: 200,
        },
      ]),
    ),
    required: ["filter_0"],
  },
  route: {
    connectorId: "fixture",
    toolName: `notes_${i}`,
    resourceId: "connected",
    catalogGroup: "Notes",
  },
}));
// A deterministic offline runtime tokenizer. Counts are fixture tokens, not vendor billing tokens.
class FakeRuntime {
  prompt = "";
  run(tools: ConnectorTool[]) {
    this.prompt = JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    );
    return this.prompt.match(/\w+|[^\s\w]/g)?.length ?? 0;
  }
}
describe("40-tool deferred loading", () => {
  it("sends names and summaries initially, and only the selected full schema on load", async () => {
    const entries = catalogEntries(fortyToolFixture);
    const deferred = lazyCatalogTools("fixture", "fixture", "Notes", entries);
    const runtime = new FakeRuntime();
    const allTokens = runtime.run(fortyToolFixture);
    const indexTokens = runtime.run(deferred);
    expect(runtime.prompt).toContain("Read note collection 39.");
    expect(runtime.prompt).not.toContain("filter_0");
    expect(indexTokens).toBeLessThan(allTokens / 3);
    const events = [];
    for await (const event of executeLazyCatalogControl(
      {
        tool: deferred[1]!.name,
        route: deferred[1]!.route,
        args: { id: "connected:notes_7" },
        executionId: "load",
      },
      entries,
      async function* () {
        yield { type: "error" as const, message: "Load cannot execute a tool" };
      },
    ))
      events.push(event);
    expect(events).toEqual([
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          name: "notes_7",
          inputSchema: fortyToolFixture[7]!.inputSchema,
        }),
      }),
    ]);
  });
  it("revalidates live authorization and schema before resolving execution", () => {
    const call = {
      tool: "fixture_execute_tool",
      route: { connectorId: "fixture", toolName: "__catalog_execute" },
      args: { id: "connected:notes_7", arguments: { filter_0: "value" } },
      executionId: "execute",
    };
    expect(resolveCatalogCall(call, catalogEntries(fortyToolFixture)).call.route).toEqual(
      fortyToolFixture[7]!.route,
    );
    expect(() =>
      resolveCatalogCall(call, catalogEntries(fortyToolFixture.filter((_, i) => i !== 7))),
    ).toThrow();
    expect(() =>
      resolveCatalogCall(
        { ...call, args: { ...call.args, arguments: {} } },
        catalogEntries(fortyToolFixture),
      ),
    ).toThrow();
  });
});
