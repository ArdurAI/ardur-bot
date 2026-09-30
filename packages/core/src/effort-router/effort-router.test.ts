import type { ThinkingLevel } from "@ardurbot/contracts";
import {
  EFFORT_ROUTE_MIN_CONFIDENCE,
  EFFORT_ROUTE_TABLE_V1_DEFAULTS,
  ThinkingLevelSchema,
} from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { EFFORT_EXAMPLES } from "./examples.js";
import { localTaskClassifier } from "./local-classifier.js";
import { routeEffort } from "./route.js";

const ALL_LEVELS: readonly ThinkingLevel[] = ThinkingLevelSchema.options;

/** A miss that routes real work to a chat budget: the one failure this framework cannot ship. */
const DANGEROUS_LABELS = new Set([
  "code-change",
  "debugging",
  "planning",
  "research",
  "operations",
]);

describe("local classifier on the example set", () => {
  const results = EFFORT_EXAMPLES.map((example) => {
    const got = localTaskClassifier.classify({ text: example.text });
    return { example, got, correct: got.taskType === example.taskType };
  });
  const correct = results.filter((r) => r.correct).length;
  const accuracy = correct / results.length;

  it(`classifies at least 0.8 of the ${results.length} examples (accuracy ${accuracy.toFixed(2)})`, () => {
    const misses = results.filter((r) => !r.correct);
    const lines = misses.map(
      (r) =>
        `  [${r.example.taskType} -> ${r.got.taskType}] ${r.example.text.split("\n")[0]?.slice(0, 70)}`,
    );
    expect(
      accuracy,
      `accuracy ${accuracy.toFixed(2)}; misses:\n${lines.join("\n")}`,
    ).toBeGreaterThanOrEqual(0.8);
  });

  it("answers every example deterministically", () => {
    for (const r of results) {
      expect(localTaskClassifier.classify({ text: r.example.text })).toEqual(r.got);
    }
  });

  it("covers every task type in the example set", () => {
    const labelled = new Set(EFFORT_EXAMPLES.map((e) => e.taskType));
    for (const taskType of Object.keys(EFFORT_ROUTE_TABLE_V1_DEFAULTS.routes)) {
      expect(labelled.has(taskType as (typeof EFFORT_EXAMPLES)[number]["taskType"])).toBe(true);
    }
  });
});

describe("no dangerous miss on the example set", () => {
  const dangerous = EFFORT_EXAMPLES.filter((e) => DANGEROUS_LABELS.has(e.taskType));

  it(`routes all ${dangerous.length} work messages to medium effort or higher`, () => {
    const misses: string[] = [];
    for (const example of dangerous) {
      const decision = routeEffort({
        classification: localTaskClassifier.classify({ text: example.text }),
        table: EFFORT_ROUTE_TABLE_V1_DEFAULTS,
        supported: ALL_LEVELS,
      });
      const rank = ALL_LEVELS.indexOf(decision.effort);
      if (rank < ALL_LEVELS.indexOf("medium")) {
        misses.push(
          `[${example.taskType} -> ${decision.effort}] ${example.text.split("\n")[0]?.slice(0, 70)}`,
        );
      }
    }
    expect(misses, `dangerous misses:\n  ${misses.join("\n  ")}`).toEqual([]);
  });

  it('never calls "hi, prod is down, fix it" small talk', () => {
    const got = localTaskClassifier.classify({ text: "hi, prod is down, fix it" });
    expect(got.taskType).not.toBe("small-talk");
    const decision = routeEffort({
      classification: got,
      table: EFFORT_ROUTE_TABLE_V1_DEFAULTS,
      supported: ALL_LEVELS,
    });
    expect(ALL_LEVELS.indexOf(decision.effort)).toBeGreaterThanOrEqual(
      ALL_LEVELS.indexOf("medium"),
    );
  });
});

describe("routing", () => {
  it("uses the unknown route below the confidence floor", () => {
    const decision = routeEffort({
      classification: {
        taskType: "debugging",
        confidence: EFFORT_ROUTE_MIN_CONFIDENCE - 0.01,
        signals: ["faint"],
      },
      table: EFFORT_ROUTE_TABLE_V1_DEFAULTS,
      supported: ALL_LEVELS,
    });
    expect(decision.taskType).toBe("unknown");
    expect(decision.effort).toBe("medium");
    expect(decision.turn).toBe("normal");
    expect(decision.reason).toContain("confidence");
  });

  it("keeps a confident classification and snaps its effort to the nearest supported level", () => {
    const decision = routeEffort({
      classification: {
        taskType: "debugging",
        confidence: EFFORT_ROUTE_MIN_CONFIDENCE,
        signals: ["stack trace"],
      },
      table: EFFORT_ROUTE_TABLE_V1_DEFAULTS,
      supported: ["minimal", "low", "medium"],
    });
    expect(decision.taskType).toBe("debugging");
    // The table wants high; the model stops at medium, which is nearer than low.
    expect(decision.effort).toBe("medium");
    expect(decision.turn).toBe("normal");
    expect(decision.reason).toContain("debugging");
  });

  it("routes a small-talk message to a light turn and the nearest low level", () => {
    const decision = routeEffort({
      classification: { taskType: "small-talk", confidence: 0.9, signals: ["greeting"] },
      table: EFFORT_ROUTE_TABLE_V1_DEFAULTS,
      supported: ["off", "low", "high", "max"],
    });
    // The table wants minimal; off exists but is only used when nothing else is.
    expect(decision.effort).toBe("low");
    expect(decision.turn).toBe("light");
  });

  it("throws when the model supports no level at all", () => {
    expect(() =>
      routeEffort({
        classification: { taskType: "small-talk", confidence: 0.9, signals: [] },
        table: EFFORT_ROUTE_TABLE_V1_DEFAULTS,
        supported: [],
      }),
    ).toThrow();
  });
});

describe("classifier interface", () => {
  it("reports signals for every answer and clamps confidence", () => {
    for (const text of ["hi", "deploy now", "", "what?"]) {
      const got = localTaskClassifier.classify({ text });
      expect(got.confidence).toBeGreaterThanOrEqual(0);
      expect(got.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(got.signals)).toBe(true);
    }
  });

  it("reads the context flags: attachments and bot answers change the reading", () => {
    const plain = localTaskClassifier.classify({ text: "hi" });
    const withAttachment = localTaskClassifier.classify({ text: "hi", hasAttachments: true });
    expect(plain.taskType).toBe("small-talk");
    expect(withAttachment.taskType).not.toBe("small-talk");
    const answer = localTaskClassifier.classify({ text: "thanks", answersBotQuestion: true });
    expect(answer.taskType).not.toBe("small-talk");
  });
});
