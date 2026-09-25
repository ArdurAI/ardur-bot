import type { ConnectorTool } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { assembleTurnContext } from "./context/assemble.js";
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
  it("counts the selected tool mode in the stable budget without charging hidden schemas", async () => {
    const instructions =
      "Use the owner's account instructions where compatible with the bot's job.";
    const deferred = lazyCatalogTools(
      "fixture",
      "fixture",
      "Notes",
      catalogEntries(fortyToolFixture),
    );
    const base = {
      instructions,
      history: [],
      message: "Read the notes",
      budgets: { stable: 16000 },
    };
    const lazy = await assembleTurnContext({ ...base, tools: deferred });
    const wire = JSON.stringify(
      deferred.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    );
    expect(lazy.snapshot.layers.stable).toBe(instructions.length + wire.length);
    expect(lazy.snapshot.layers.stable).toBeLessThan(16000);
    await expect(assembleTurnContext({ ...base, tools: fortyToolFixture })).rejects.toThrow(
      "including exposed tools",
    );
    const eager = await assembleTurnContext({
      ...base,
      budgets: { stable: 64000 },
      tools: fortyToolFixture.slice(0, 20),
    });
    expect(eager.snapshot.layers.stable).toBeGreaterThan(lazy.snapshot.layers.stable);
    expect(lazy.stablePrefix).toBe(instructions);
  });
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
