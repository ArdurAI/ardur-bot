import type { ConnectorCall } from "@ardurbot/adapter-kit";
import type { ChiefActivity } from "@ardurbot/contracts";
import { CHIEF_ACTIVITY_TEXT } from "@ardurbot/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chiefActivityFeed } from "./chief-activity.js";

afterEach(() => vi.useRealTimers());
describe("chief tool feed", () => {
  function feed() {
    const writes: ChiefActivity[] = [];
    const instance = chiefActivityFeed({
      revision: 1,
      runId: "run",
      delegationId: "assignment",
      attempt: 2,
      write: async (activity) => {
        writes.push(activity);
      },
    });
    return { instance, writes };
  }
  it.each([
    ["notion-get-users", "notion", "Connecting to Notion"],
    ["notion-create-pages", "notion", "Creating the Notion page"],
    ["notion-fetch", "notion", "Checking the Notion page"],
    ["__catalog_search", undefined, "Checking the missing tool"],
    ["__catalog_load", undefined, "Checking the missing tool"],
  ] as const)(
    "projects the recorded %s tool through the production feed",
    async (toolName, serviceId, phrase) => {
      const { instance, writes } = feed();
      const call: ConnectorCall = {
        tool: toolName.startsWith("__catalog_")
          ? "connector_search_tools"
          : `mcp__workspace__${toolName}`,
        executionId: "real-shaped-call",
        args: { user_id: "self", content: "secret-token https://private.invalid" },
        route: {
          connectorId: "mcp",
          resourceId: "connection",
          resourceRevision: 1,
          toolName,
          serviceId,
          catalogGroup: "workspace",
        },
      };
      await instance.startTool(call);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ state: "active", executionId: call.executionId });
      expect(CHIEF_ACTIVITY_TEXT[writes[0]!.key]).toBe(phrase);
      expect(JSON.stringify(writes)).not.toMatch(/secret-token|private\.invalid|user_id|content/);
      await instance.settle("completed");
    },
  );
  it.each([
    { tool: "shell" },
    { tool: "mcp__notion__notion-get-users" },
    {
      tool: "mcp__notion__notion-get-users",
      route: {
        connectorId: "mcp",
        toolName: "notion-get-users",
        catalogGroup: "notion",
        serviceId: "other",
      },
    },
    {
      tool: "mcp__notion__unknown",
      route: { connectorId: "mcp", toolName: "unknown", serviceId: "notion" },
    },
  ])(
    "does not infer service activity from untrusted names or arguments: $tool",
    async (identity) => {
      const { instance, writes } = feed();
      await instance.startTool({
        ...identity,
        executionId: "hostile-call",
        args: {
          command: "notion-get-users secret-token https://private.invalid",
          capability: "notion-connect",
        },
      });
      expect(CHIEF_ACTIVITY_TEXT[writes[0]!.key]).toBe("Working on the task");
      expect(JSON.stringify(writes)).not.toMatch(
        /secret-token|private\.invalid|command|capability/,
      );
      await instance.settle("completed");
    },
  );
  it("deduplicates tool identities and retains the last genuine action between tools", async () => {
    const { instance, writes } = feed();
    await instance.start("call", "read-input");
    await instance.start("call", "write-notion");
    await instance.finish("call");
    expect(writes.map((row) => [row.key, row.state])).toEqual([
      ["read-input", "active"],
      ["read-input", "idle"],
    ]);
    expect(writes.every((row) => row.runId === "run" && row.attempt === 2)).toBe(true);
    await instance.settle("completed");
    await instance.start("late", "write-notion");
    expect(writes.at(-1)?.state).toBe("completed");
  });
  it("waits after fifteen seconds only while a tool is still active", async () => {
    vi.useFakeTimers();
    const { instance, writes } = feed();
    await instance.start("slow", "connect-notion");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes.at(-1)?.key).toBe("waiting-tool");
    await instance.finish("slow");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(writes.at(-1)?.state).toBe("idle");
    await instance.settle("completed");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("parallel calls retain another active tool when the latest finishes", async () => {
    const { instance, writes } = feed();
    await instance.start("first", "read-input");
    await instance.start("second", "verify-notion");
    await instance.finish("second");
    expect(writes.at(-1)).toMatchObject({
      key: "read-input",
      state: "active",
      executionId: "first",
    });
    await instance.settle("waiting");
  });
  it("settlement cancels owned timers and overrides tools without waking a model", async () => {
    vi.useFakeTimers();
    const { instance, writes } = feed();
    await instance.start("call", "working");
    await instance.settle("stopped");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes.map((row) => row.state)).toEqual(["active", "stopped"]);
    expect(writes.map((row) => row.sourceSeq)).toEqual([1, 2]);
  });
  it("a projection outage cannot fail tool execution or poison terminal settlement", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("projection unavailable"))
      .mockResolvedValue(undefined);
    const instance = chiefActivityFeed({
      revision: 1,
      runId: "run",
      delegationId: "assignment",
      attempt: 1,
      write,
    });
    await expect(instance.start("call", "read-input")).resolves.toBeUndefined();
    await instance.settle("completed");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0].state).toBe("completed");
  });
});
