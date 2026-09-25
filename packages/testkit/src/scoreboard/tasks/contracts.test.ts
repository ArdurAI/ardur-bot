import { describe, expect, it } from "vitest";
import type { OutcomeObservation } from "../graders/outcome.js";
import { gradeOutcome } from "../graders/outcome.js";
import { TASK_DEFINITIONS } from "../manifest.js";
import { DEPARTMENT_TASKS, TASK_PACK_HASH } from "./catalog.js";
import { referenceSolution } from "./reference.js";
import { simulateCapacity, taskMaterial } from "./variants.js";

function referenceObservation(index: number): OutcomeObservation {
  const task = DEPARTMENT_TASKS[index]!;
  const solution = referenceSolution(task);
  return {
    result: solution.result,
    files: { ...task.files, ...solution.files },
    state: task.initialState.map((row) => {
      const updated = solution.updates.find((update) => update.id === row.id);
      return updated
        ? { id: row.id, value: updated.value, revision: row.revision + 1 }
        : structuredClone(row);
    }),
    effects: solution.updates.map((update) => ({
      id: update.id,
      revision: update.revision + 1,
      authorized: true,
    })),
    tools: ["read_file", "write_file", ...solution.updates.map(() => "SCOREBOARD_UPDATE")],
    expectedPin: {
      runtime: "pi",
      provider: "openai-compatible",
      model: "scoreboard-v1",
      effort: null,
      computer: "fixture",
    },
    observedPin: {
      runtime: "pi",
      provider: "openai-compatible",
      model: "scoreboard-v1",
      effort: null,
      computer: "fixture",
    },
    elapsedMs: 0,
    terminal: "completed",
  };
}

describe("fixed department contracts", () => {
  it("simulates all declared capacities from the complete current request including tool schemas", () => {
    for (const capacity of [16000, 128000, 1000000] as const) {
      const request = { messages: [{ role: "user", content: "x".repeat(100) }], tools: [] };
      const count = simulateCapacity(request, capacity, 0).tokens;
      expect(simulateCapacity(request, capacity, capacity - count).fits).toBe(true);
      expect(simulateCapacity(request, capacity, capacity - count + 1).fits).toBe(false);
      const wider = { ...request, tools: [{ description: "x".repeat(capacity * 4) }] };
      expect(simulateCapacity(wider, capacity, 0)).toMatchObject({
        fits: false,
        exactness: "estimate",
        actualRouteCapacity: null,
      });
    }
  });
  it("implements exactly the frozen 24 definitions without mutating the predecessor manifest", () => {
    expect(DEPARTMENT_TASKS.map(({ id, department, name }) => ({ id, department, name }))).toEqual(
      TASK_DEFINITIONS.map(({ id, department, name }) => ({ id, department, name })),
    );
    expect(DEPARTMENT_TASKS).toHaveLength(24);
    expect(TASK_PACK_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(() => {
      Object.assign(DEPARTMENT_TASKS[0]!.files, { "policy.json": "changed" });
    }).toThrow();
  });

  it.each(DEPARTMENT_TASKS.map((task, index) => ({ task, index })))(
    "$task.id reference passes; fact, citation, state, permission, pin, deadline and false-completion controls fail",
    ({ task, index }) => {
      const reference = referenceObservation(index);
      expect(gradeOutcome(task, reference).passed).toBe(true);
      const controls: OutcomeObservation[] = [
        { ...reference, result: { ...referenceSolution(task).result, facts: {} } },
        { ...reference, result: { ...referenceSolution(task).result, citations: [] } },
        {
          ...reference,
          state: [...reference.state, { id: "unrequested", revision: 1, value: {} }],
        },
        {
          ...reference,
          effects: [
            ...reference.effects,
            { id: "unsolicited-send", revision: 1, authorized: false },
          ],
        },
        { ...reference, tools: [...reference.tools, "send_email"] },
        { ...reference, observedPin: { model: "substitution" } },
        { ...reference, elapsedMs: task.deadlineMs + 1 },
        { ...reference, files: { ...task.files } },
        { ...reference, terminal: "uncertain" },
      ];
      for (const control of controls) expect(gradeOutcome(task, control).passed).toBe(false);
      // Preserve the saved JSON while changing one fact: the grader must check meaning, not delivery.
      const wrong = structuredClone(referenceSolution(task).result);
      wrong.facts[Object.keys(wrong.facts)[0]!] = "wrong-but-delivered";
      expect(
        gradeOutcome(task, {
          ...reference,
          result: wrong,
          files: { ...reference.files, "result.json": JSON.stringify(wrong) },
        }).checks.facts,
      ).toBe(false);
    },
  );

  it("keeps hidden oracle and reference solutions out of every agent-visible variant", () => {
    for (const task of DEPARTMENT_TASKS)
      for (const history of ["short", "long"] as const)
        for (const tools of ["local", "remote"] as const)
          for (const capacity of [16000, 128000, 1000000] as const) {
            const material = taskMaterial(task, { history, tools, capacity });
            expect(Object.keys(material).sort()).toEqual([
              "allowedTools",
              "capacity",
              "consent",
              "files",
              "history",
              "initialState",
              "prompt",
              "scope",
              "taskId",
            ]);
            expect(material.capacity.actualRouteCapacity).toBeNull();
            if (history === "long") {
              expect(material.history.length).toBeGreaterThan(200);
              expect(
                Math.max(...material.history.map((message) => message.content.length)),
              ).toBeGreaterThan(40000);
            }
          }
  });

  it("rejects a duplicate approved update and a repaired summary without the actual repair", () => {
    const update = referenceObservation(3);
    expect(
      gradeOutcome(DEPARTMENT_TASKS[3]!, {
        ...update,
        effects: [...update.effects, ...update.effects],
      }).criticalPassed,
    ).toBe(false);
    const repair = referenceObservation(20);
    expect(
      gradeOutcome(DEPARTMENT_TASKS[20]!, {
        ...repair,
        files: {
          ...repair.files,
          "src/settings.json": DEPARTMENT_TASKS[20]!.files["src/settings.json"]!,
        },
      }).passed,
    ).toBe(false);
  });
});
