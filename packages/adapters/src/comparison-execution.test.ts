import { createHash } from "node:crypto";
import type { AdapterContext, AgentRunRequest, ArtifactStore } from "@ardurbot/adapter-kit";
import { expect, it, vi } from "vitest";
import { startComparison } from "./comparison.js";
import { comparisonRequest, comparisonToolAllowed } from "./comparison-execution.js";
import { comparisonFixture, comparisonInput, comparisonScope } from "./comparison-test-fixture.js";

it("gives workers identical frozen input without sibling results, memory, native sessions or steering", async () => {
  const f = comparisonFixture();
  const comparison = await startComparison(f.deps, comparisonScope, comparisonInput);
  const requests: AgentRunRequest[] = [];
  const executeTool = vi.fn();
  for (const result of comparison.results) {
    const request: AgentRunRequest = {
      botId: result.botId,
      threadId: "thread",
      runId: result.runId,
      prompt: "Mutable task",
      instructions: "Private persona memory",
      history: [{ role: "assistant", content: "Sibling result in shared thread" }],
      nativeSession: { runtimeKind: "claude-code", sessionId: "ambient-session" },
      nativeCwd: "/shared/siblings",
      resumeFromCheckpoint: "old-history",
      claimSteering: vi.fn(),
      admitHelper: vi.fn(),
      resolveModel: vi.fn(),
      executeTool,
      tools: [
        "web_search",
        "web_fetch",
        "shell",
        "read_file",
        "message_bot",
        "delegation_status",
        "recall_memory",
        "save_memory",
        "run_subagent",
        "scratchpad_add",
        "complete_task",
        "report_progress",
      ].map((name) => ({ name, description: name, inputSchema: {} })),
      model: { provider: "fixture", id: result.botId },
      script: [
        {
          assistant: "Output",
          memory: [{ scope: "bot", path: "memory", content: "contamination" }],
          files: [{ path: "../sibling", content: "contamination" }],
        },
      ],
    };
    const next = await comparisonRequest(
      f.deps,
      { ...comparisonScope, id: result.runId, botId: result.botId, comparisonId: comparison.id },
      request,
      {
        ...comparisonScope,
        operationId: "fixture",
        traceId: "fixture",
        signal: new AbortController().signal,
      },
    );
    requests.push(next);
    expect(next).toMatchObject({
      history: [],
      nativeSession: undefined,
      nativeCwd: undefined,
      claimSteering: undefined,
      admitHelper: undefined,
      resolveModel: undefined,
      resumeFromCheckpoint: undefined,
      script: [{ assistant: "Output" }],
    });
    expect(JSON.stringify(next)).not.toContain("Sibling result");
    expect(JSON.stringify(next)).not.toContain("Private persona");
    expect(next.tools).toEqual(
      request.tools === "none"
        ? []
        : request.tools.filter((tool) =>
            ["web_search", "web_fetch", "report_progress"].includes(tool.name),
          ),
    );
    expect(await next.executeTool!("read_file", { path: "../sibling" }, "tool")).toHaveProperty(
      "error",
    );
    await expect(next.authorizeTool!("run_subagent")).rejects.toThrow("unavailable");
  }
  expect(requests[0]!.prompt).toBe(requests[1]!.prompt);
  expect(requests[0]!.instructions).toBe(requests[1]!.instructions);
  expect(executeTool).not.toHaveBeenCalled();
});
it("uses the same tool boundary even when a runtime guesses a hidden tool name", () => {
  for (const name of [
    "message_bot",
    "handoff_to_bot",
    "run_subagent",
    "save_memory",
    "remember",
    "read_file",
    "catalog_execute",
    "shell",
    "accept_delegation",
  ])
    expect(comparisonToolAllowed(name)).toBe(false);
});
it("keeps ordinary requests untouched", async () => {
  const f = comparisonFixture();
  const request = {} as AgentRunRequest;
  expect(
    await comparisonRequest(
      f.deps,
      { ...comparisonScope, id: "ordinary", botId: "worker" },
      request,
      {} as AdapterContext,
    ),
  ).toBe(request);
  expect(f.comparisonExecution.findFirstOrThrow).not.toHaveBeenCalled();
});

it("reads only frozen attached bytes and refuses a changed artifact or a sibling artifact", async () => {
  const f = comparisonFixture();
  const bytes = new TextEncoder().encode("Frozen evidence");
  const artifact = {
    id: "artifact",
    name: "evidence.txt",
    mimeType: "text/plain",
    hash: createHash("sha256").update(bytes).digest("hex"),
    storageKey: "frozen-artifact",
  };
  f.tx.artifact.findFirstOrThrow.mockResolvedValue(artifact);
  const comparison = await startComparison(f.deps, comparisonScope, {
    ...comparisonInput,
    artifactIds: ["artifact"],
  });
  const result = comparison.results[0]!;
  f.policies.push({ layer: "space", subjectId: "space", scopes: ["ordinary"] });
  const get = vi.fn(async () => bytes);
  const artifacts = { get } as unknown as ArtifactStore;
  const request = await comparisonRequest(
    { ...f.deps, artifacts },
    { ...comparisonScope, id: result.runId, botId: result.botId, comparisonId: comparison.id },
    { tools: "none" } as AgentRunRequest,
    { ...comparisonScope, signal: new AbortController().signal } as AdapterContext,
  );
  expect(
    await request.executeTool!("read_comparison_artifact", { artifactId: "artifact" }, "read"),
  ).toMatchObject({ content: "Frozen evidence", encoding: "text", nextOffset: null });
  expect(f.tx.artifact.findFirstOrThrow).toHaveBeenLastCalledWith({
    where: { id: "artifact", ...comparisonScope },
  });
  await expect(
    request.executeTool!("read_comparison_artifact", { artifactId: "sibling" }, "read"),
  ).rejects.toThrow("outside the frozen input");
  get.mockResolvedValueOnce(new TextEncoder().encode("Changed evidence"));
  await expect(
    request.executeTool!("read_comparison_artifact", { artifactId: "artifact" }, "read"),
  ).rejects.toThrow("artifact changed");
});
