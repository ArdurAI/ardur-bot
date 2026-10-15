import type { AgentRuntime } from "@ardurbot/adapter-kit";
import { RUNTIME_BEHAVIORS, RuntimeEvidenceSchema, RuntimeKindSchema } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { startComparison } from "./comparison.js";
import { comparisonRequest } from "./comparison-execution.js";
import { comparisonFixture, comparisonInput, comparisonScope } from "./comparison-test-fixture.js";
import { RuntimeRegistry, registeredRuntimeCapabilityReport } from "./runtime-registry.js";

const report = {
  version: 1,
  runtimeKind: "pi",
  adapterId: "fixture",
  adapterVersion: "1",
  runtimeVersion: "fixture-1",
  mode: "offline",
  checks: RUNTIME_BEHAVIORS.map((behavior) => ({ behavior, verdict: "not-tested" })),
};
function fixture(evidence: unknown) {
  const probe = vi.fn(),
    run = vi.fn(),
    abort = vi.fn();
  const runtime = {
    describe: () => ({
      id: "fixture",
      adapterVersion: "1",
      capabilities: { streaming: true, tools: false, scripted: true, compaction: false },
    }),
    run,
    abort,
  } as unknown as AgentRuntime;
  return {
    probe,
    run,
    abort,
    registry: new RuntimeRegistry({ pi: { factory: () => runtime, probe, evidence } }),
  };
}
describe("versioned runtime evidence", () => {
  it("publishes untested metadata for every registered runtime without launching a probe", () => {
    for (const kind of RuntimeKindSchema.options) {
      const result = registeredRuntimeCapabilityReport(kind);
      expect(result.runtimeKind).toBe(kind);
      expect(result.runtimeVersion).toBeNull();
      expect(result.checks).toHaveLength(5);
      expect(result.checks.every((check) => check.verdict === "not-tested")).toBe(true);
    }
  });
  it("loads matching fixture evidence without running the runtime", () => {
    const f = fixture({
      ...report,
      checks: report.checks.map((check) =>
        check.behavior === "streaming" ? { ...check, verdict: "confirmed" } : check,
      ),
    });
    expect(f.registry.capabilityReport("pi", "fixture-1").checks[0]?.verdict).toBe("confirmed");
    expect(f.registry.capabilityReport("pi", "fixture-2")).toMatchObject({
      evidenceMode: "not-tested",
      versionMismatch: true,
    });
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.abort).not.toHaveBeenCalled();
  });
  it("rejects unknown behavior IDs, duplicates and no-attempt denial claims", () => {
    for (const checks of [
      [...report.checks.slice(1), { behavior: "invented", verdict: "confirmed" }],
      report.checks.map(() => report.checks[0]),
      report.checks.map((check) =>
        check.behavior === "tool-authorization"
          ? { ...check, verdict: "confirmed", attempts: 0, denied: 0, effects: 0 }
          : check,
      ),
    ])
      expect(RuntimeEvidenceSchema.safeParse({ ...report, checks }).success).toBe(false);
  });
  it("confirms denial only after a real attempted Ardur tool gate with no effect", async () => {
    const f = comparisonFixture();
    const comparison = await startComparison(f.deps, comparisonScope, comparisonInput);
    const result = comparison.results[0]!;
    const execute = vi.fn();
    const request = await comparisonRequest(
      f.deps,
      { ...comparisonScope, id: result.runId, botId: result.botId, comparisonId: comparison.id },
      { tools: "none", executeTool: execute } as never,
      {} as never,
    );
    const outcome = await request.executeTool!("shell", { command: "forbidden" }, "attempt");
    expect(outcome).toHaveProperty("error");
    expect(execute).not.toHaveBeenCalled();
    const observed = RuntimeEvidenceSchema.parse({
      ...report,
      checks: report.checks.map((check) =>
        check.behavior === "tool-authorization"
          ? {
              ...check,
              verdict: "confirmed",
              attempts: 1,
              denied: 1,
              effects: execute.mock.calls.length,
            }
          : check,
      ),
    });
    expect(
      fixture(observed)
        .registry.capabilityReport("pi", "fixture-1")
        .checks.find((check) => check.behavior === "tool-authorization")?.verdict,
    ).toBe("confirmed");
  });
});
