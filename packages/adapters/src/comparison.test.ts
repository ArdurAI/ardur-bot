import {
  AppBootstrapSchema,
  ComparisonExportSchema,
  RunActivityRowSchema,
  RunSchema,
  ThreadSnapshotSchema,
} from "@ardurbot/contracts";
import { readComparison } from "@ardurbot/db";
import { describe, expect, it } from "vitest";
import { mergeComparison, startComparison } from "./comparison.js";
import { comparisonFixture, comparisonInput, comparisonScope } from "./comparison-test-fixture.js";

describe("comparison orchestration through P2 admission", () => {
  it("accepts persisted comparison runs in thread, bootstrap and Activity reads after reload", async () => {
    const f = comparisonFixture();
    await startComparison(f.deps, comparisonScope, comparisonInput);
    const rows = JSON.parse(
      JSON.stringify(f.state().runs.filter((row) => row.trigger?.startsWith("comparison"))),
    );
    expect(new Set(rows.map((row: { trigger: string }) => row.trigger))).toEqual(
      new Set(["comparison", "comparison-coordinator"]),
    );
    for (const row of rows) {
      const run = RunSchema.parse({
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        ...row,
      });
      const thread = { threadId: run.threadId, cursor: -1, messages: [], olderCursor: null, run };
      expect(ThreadSnapshotSchema.safeParse(thread).success).toBe(true);
      expect(AppBootstrapSchema.shape.thread.safeParse(thread).success).toBe(true);
      expect(
        RunActivityRowSchema.safeParse({
          runId: run.id,
          botId: run.botId,
          botName: "Fixture",
          groupId: null,
          groupName: null,
          threadId: run.threadId,
          status: run.status,
          trigger: run.trigger,
          notificationsEnabled: false,
          promptSnippet: "Compare",
          updatedAt: row.createdAt,
        }).success,
      ).toBe(true);
    }
  });
  it("keeps effort evidence in comparison results and exported JSON", async () => {
    const f = comparisonFixture();
    const comparison = await startComparison(f.deps, comparisonScope, comparisonInput);
    const run = f.state().runs.find((run) => run.id === comparison.results[0]!.runId);
    run.runtimeInfo = {
      runtimeKind: "claude-code",
      effortAttested: false,
      effortAttestationReason: "Claude Code does not report the applied effort",
    };
    const read = await readComparison(f.prisma, comparisonScope, comparison.id);
    const exported = ComparisonExportSchema.parse(
      JSON.parse(
        JSON.stringify({
          format: "ardurbot.comparison",
          version: 1,
          exportedAt: new Date().toISOString(),
          comparison: read,
        }),
      ),
    );
    expect(exported.comparison.results[0]!.provenance).toMatchObject({
      effortAttested: false,
      effortAttestationReason: "Claude Code does not report the applied effort",
    });
    expect(exported.comparison.participants).toEqual(comparison.participants);
  });
  it("freezes once, admits the current bot, preserves order and reserves participants plus merge once", async () => {
    const f = comparisonFixture();
    const result = await startComparison(f.deps, comparisonScope, comparisonInput);
    expect(result.participants.map((item) => item.botId)).toEqual(["coordinator", "worker"]);
    expect(f.state().executions[0].input).toEqual(f.state().executions[1].input);
    expect(f.state().root).toMatchObject({
      reservedTokens: 30000,
      totalDescendants: 2,
      activeDescendants: 2,
    });
    expect(
      f
        .state()
        .rows.every(
          (row) => row.comparisonId === result.id && row.card.goal === comparisonInput.text,
        ),
    ).toBe(true);
    const frozen = structuredClone(result.snapshot);
    f.bot.name = "Changed persona";
    const replay = await startComparison(f.deps, comparisonScope, comparisonInput);
    expect(replay.snapshot).toEqual(frozen);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
    expect(f.state().root.reservedTokens).toBe(30000);
    const exported = ComparisonExportSchema.parse(
      JSON.parse(
        JSON.stringify({
          format: "ardurbot.comparison",
          version: 1,
          exportedAt: new Date().toISOString(),
          comparison: result,
        }),
      ),
    );
    expect(exported.comparison.snapshot).toEqual(result.snapshot);
    expect(exported.comparison.results.map((row) => row.runId)).toEqual(
      result.results.map((row) => row.runId),
    );
    expect(exported.comparison).not.toHaveProperty("ranking");
  });
  it.each([{ tokenLimit: 20000 }, { maxConcurrent: 1 }, { maxDescendants: 1 }, { maxDepth: 0 }])(
    "rolls back the entire fan-out at a root cap: %j",
    async (policy) => {
      const f = comparisonFixture(policy);
      const before = structuredClone(f.state());
      await expect(startComparison(f.deps, comparisonScope, comparisonInput)).rejects.toThrow();
      expect(f.state()).toEqual(before);
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );
  it("scopes every participant and refuses cross-space results and merges", async () => {
    const f = comparisonFixture();
    const result = await startComparison(f.deps, comparisonScope, comparisonInput);
    await expect(
      readComparison(f.prisma, { ...comparisonScope, spaceId: "other" }, result.id),
    ).rejects.toThrow();
    await expect(
      startComparison(f.deps, comparisonScope, {
        ...comparisonInput,
        clientNonce: "foreign",
        participantBotIds: ["coordinator", "foreign"],
      }),
    ).rejects.toThrow();
    await expect(
      mergeComparison(
        f.deps,
        { ...comparisonScope, spaceId: "other" },
        {
          id: result.id,
          selectedRunIds: [result.results[0]!.runId],
          botId: "worker",
          reserveBudget: true,
        },
      ),
    ).rejects.toThrow();
  });
  it("pauses one participant, keeps completion order out of display order, and reports unknown provenance honestly", async () => {
    const f = comparisonFixture();
    const comparison = await startComparison(f.deps, comparisonScope, comparisonInput);
    const first = comparison.results[0]!;
    const second = comparison.results[1]!;
    f.state().runs.find((run) => run.id === first.runId).status = "waiting_input";
    f.state().messages.push({
      id: "approval",
      runId: first.runId,
      role: "bot",
      seq: 0,
      blocks: [
        { kind: "ask", text: "Allow this lookup?", status: "pending", approvalEffectId: "effect" },
      ],
    });
    await f.complete(second.runId, "Second finished first https://example.test/source");
    const result = await readComparison(f.prisma, comparisonScope, comparison.id);
    expect(result.results.map((row) => row.status)).toEqual(["waiting-approval", "completed"]);
    expect(result.results[0]!.approvals[0]!.messageId).toBe("approval");
    expect(result.results[1]!.citations).toEqual(["https://example.test/source"]);
    expect(result.results[1]!.usage).toMatchObject({ reported: false, costs: [] });
    expect(result.results[1]!.provenance.reportedModel).toBeNull();
    expect(f.state().root).toMatchObject({ activeDescendants: 1, reservedTokens: 20000 });
  });
  it("merges only selected outputs as a separate pinned run and transfers the reserved budget", async () => {
    const f = comparisonFixture();
    const comparison = await startComparison(f.deps, comparisonScope, comparisonInput);
    await f.complete(comparison.results[0]!.runId, "Selected evidence");
    await f.complete(comparison.results[1]!.runId, "Unselected private alternative");
    const input = {
      id: comparison.id,
      selectedRunIds: [comparison.results[0]!.runId],
      botId: "third",
      reserveBudget: false,
    };
    const merged = await mergeComparison(f.deps, comparisonScope, input);
    const execution = f.state().executions.find((row) => row.position === 4);
    expect(execution.input.sources).toHaveLength(1);
    expect(JSON.stringify(execution.input)).not.toContain("Unselected");
    expect(JSON.stringify(execution.input)).not.toContain(comparisonInput.text);
    expect(execution.input.instruction).toContain("disagreements");
    expect(merged.merge!.participant.executing.pin.modelId).toBe("third");
    expect(merged.merge!.result.runId).not.toBe(comparison.results[0]!.runId);
    expect(f.state().root).toMatchObject({ totalDescendants: 3, reservedTokens: 10000 });
    expect((await mergeComparison(f.deps, comparisonScope, input)).merge!.result.runId).toBe(
      merged.merge!.result.runId,
    );
    expect(f.state().root.totalDescendants).toBe(3);
  });
  it("requires an explicit reservation when merge was not reserved", async () => {
    const f = comparisonFixture();
    const comparison = await startComparison(f.deps, comparisonScope, {
      ...comparisonInput,
      reserveMerge: false,
    });
    await f.complete(comparison.results[0]!.runId, "Selected");
    const input = {
      id: comparison.id,
      selectedRunIds: [comparison.results[0]!.runId],
      botId: "coordinator",
      reserveBudget: false,
    };
    await expect(mergeComparison(f.deps, comparisonScope, input)).rejects.toThrow(
      "Reserve one more run",
    );
    expect(f.state().root.reservedTokens).toBe(10000);
    expect(
      (await mergeComparison(f.deps, comparisonScope, { ...input, reserveBudget: true })).merge,
    ).not.toBeNull();
  });
});
