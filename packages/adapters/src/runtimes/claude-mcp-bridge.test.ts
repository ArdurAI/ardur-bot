import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "../approval-effect.js";
import { createArdurMcpProtocol } from "./ardur-mcp-server.js";
import { createArdurToolBridge } from "./claude-mcp-bridge.js";

const request = (): AgentRunRequest => ({
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "test",
  instructions: "",
  history: [],
  model: { provider: "anthropic", id: "model" },
  tools: [
    {
      name: "write_file",
      description: "Write",
      inputSchema: { type: "object" },
      route: { connectorId: "test", toolName: "write" },
    },
  ],
});
describe("Ardur MCP approval bridge", () => {
  it("routes SDK tools/call to the executor once, keeping routing metadata private", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const completion = vi.fn();
    const emit = vi.fn();
    const bridge = createArdurToolBridge(
      { ...request(), executeTool, onToolCompleted: completion },
      emit,
      vi.fn(),
    );
    const server = createArdurMcpProtocol(bridge);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const { tools } = await client.listTools();
      expect(tools[0]).not.toHaveProperty("route");
      await client.callTool({ name: "write_file", arguments: { path: "test" } });
      expect(executeTool).toHaveBeenCalledOnce();
      expect(executeTool).toHaveBeenCalledWith("write_file", { path: "test" }, expect.any(String), {
        connectorId: "test",
        toolName: "write",
      });
      expect(completion).toHaveBeenCalledOnce();
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tool", name: "write_file" }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("a denied approval performs no effect and closes later queued calls", async () => {
    const effect = vi.fn();
    const pause = vi.fn();
    const bridge = createArdurToolBridge(
      { ...request(), authorizeTool: async () => approvalPausedToolResult(), executeTool: effect },
      vi.fn(),
      pause,
    );
    const results = await Promise.allSettled([
      bridge.call("write_file", {}),
      bridge.call("write_file", {}),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(effect).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledOnce();
  });
  it("does not pretend Pi-owned helpers ran", async () => {
    const bridge = createArdurToolBridge(request(), vi.fn(), vi.fn());
    await expect(bridge.call("run_subagent", {})).rejects.toThrow("unavailable");
  });
  it("rechecks the pin after asynchronous authorization, before performing an effect", async () => {
    let valid = true;
    const effect = vi.fn();
    const bridge = createArdurToolBridge(
      {
        ...request(),
        executeTool: effect,
        authorizeTool: async () => {
          valid = false;
          return undefined;
        },
      },
      vi.fn(),
      vi.fn(),
      () => valid,
    );
    await expect(bridge.call("write_file", {})).rejects.toThrow("not ready");
    expect(effect).not.toHaveBeenCalled();
  });
  it("records a thrown tool failure once without replaying it", async () => {
    const error = new Error("Unavailable tool");
    const executeTool = vi.fn().mockRejectedValue(error);
    const completion = vi.fn();
    const bridge = createArdurToolBridge(
      { ...request(), executeTool, onToolCompleted: completion },
      vi.fn(),
      vi.fn(),
    );
    await expect(bridge.call("write_file", {})).rejects.toBe(error);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(completion).toHaveBeenCalledOnce();
    expect(completion).toHaveBeenCalledWith(expect.objectContaining({ error, paused: false }));
  });
  it("maps interactive Ardur tools to an ask card and stops the process", async () => {
    const emit = vi.fn();
    const pause = vi.fn();
    const executeTool = vi.fn();
    const bridge = createArdurToolBridge(
      {
        ...request(),
        executeTool,
        tools: [{ name: "ask_user", description: "Ask", inputSchema: { type: "object" } }],
      },
      emit,
      pause,
    );
    await expect(
      bridge.call("ask_user", { question: "Which file?", options: ["One", "Two"] }),
    ).rejects.toThrow("Waiting");
    expect(emit).toHaveBeenCalledWith({
      type: "ask",
      text: "Which file?",
      actions: [
        { id: "choice-1", label: "One" },
        { id: "choice-2", label: "Two" },
      ],
    });
    expect(pause).toHaveBeenCalledOnce();
    expect(executeTool).not.toHaveBeenCalled();
  });
});
