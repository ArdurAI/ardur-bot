import type { ThinkingLevel } from "@ardurbot/contracts";
import {
  EFFORT_ROUTE_MIN_CONFIDENCE,
  EFFORT_ROUTE_TABLE_V1_DEFAULTS,
  ThinkingLevelSchema,
} from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { EFFORT_EXAMPLES, type EffortExample } from "./examples.js";
import { localTaskClassifier } from "./local-classifier.js";
import { routeEffort } from "./route.js";

const ALL_LEVELS: readonly ThinkingLevel[] = ThinkingLevelSchema.options;

/**
 * Labels whose message asks for real work. Routing one of these to minimal or low effort
 * is the one failure this framework cannot ship: a failure investigated at chat depth.
 */
const DANGEROUS_LABELS = new Set([
  "code-change",
  "debugging",
  "planning",
  "research",
  "operations",
]);

/**
 * The honest split. Every third example of the full set (index % 3 === 0) is `check` and
 * is never looked at while the rules are tuned; the rest is `tune`. The rule is fixed
 * before any example is written and never moved.
 */
function splitExamples(examples: readonly EffortExample[]): {
  tune: EffortExample[];
  check: EffortExample[];
} {
  const tune: EffortExample[] = [];
  const check: EffortExample[] = [];
  examples.forEach((example, index) => {
    (index % 3 === 0 ? check : tune).push(example);
  });
  return { tune, check };
}

const SPLIT = splitExamples(EFFORT_EXAMPLES);

function accuracy(examples: readonly EffortExample[]): number {
  if (examples.length === 0) return 0;
  const correct = examples.filter(
    (example) => localTaskClassifier.classify({ text: example.text }).taskType === example.taskType,
  ).length;
  return correct / examples.length;
}

/** Work-labelled examples that were routed to a chat budget (minimal or low effort). */
function dangerousMisses(examples: readonly EffortExample[]): string[] {
  const misses: string[] = [];
  for (const example of examples) {
    if (!DANGEROUS_LABELS.has(example.taskType)) continue;
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
  return misses;
}

describe("tune/check split", () => {
  it("splits by a fixed rule: every third example is check", () => {
    const all = SPLIT.tune.concat(SPLIT.check);
    expect(all.length).toBe(EFFORT_EXAMPLES.length);
    expect(new Set(all.map((e) => e.text)).size).toBe(EFFORT_EXAMPLES.length);
    expect(SPLIT.tune.length).toBeGreaterThan(0);
    expect(SPLIT.check.length).toBeGreaterThanOrEqual(60);
  });

  it("keeps every task type in both parts", () => {
    const types = new Set(EFFORT_EXAMPLES.map((e) => e.taskType));
    for (const part of [SPLIT.tune, SPLIT.check]) {
      const present = new Set(part.map((e) => e.taskType));
      for (const taskType of types) expect(present.has(taskType)).toBe(true);
    }
  });
});

describe.each([
  ["tune", () => SPLIT.tune],
  ["check", () => SPLIT.check],
] as const)("local classifier on the %s part", (name, part) => {
  it(
    `classifies at least 0.75 of the ${part().length} ${name} examples` +
      ` (accuracy ${accuracy(part()).toFixed(2)})`,
    () => {
      const examples = part();
      const misses = examples
        .filter(
          (example) =>
            localTaskClassifier.classify({ text: example.text }).taskType !== example.taskType,
        )
        .map(
          (example) =>
            `[${example.taskType} -> ${localTaskClassifier.classify({ text: example.text }).taskType}] ${example.text.split("\n")[0]?.slice(0, 70)}`,
        );
      expect(accuracy(examples), `misses:\n  ${misses.join("\n  ")}`).toBeGreaterThanOrEqual(0.75);
    },
  );

  it(`has no dangerous miss on the ${name} part`, () => {
    expect(
      dangerousMisses(part()),
      `dangerous misses:\n  ${dangerousMisses(part()).join("\n  ")}`,
    ).toEqual([]);
  });

  it(`answers every ${name} example deterministically`, () => {
    for (const example of part()) {
      const first = localTaskClassifier.classify({ text: example.text });
      expect(localTaskClassifier.classify({ text: example.text })).toEqual(first);
    }
  });
});

describe("light routes are earned (property over every example)", () => {
  it("never routes a message with a hard work marker to a light task type", () => {
    const offenders: string[] = [];
    for (const example of EFFORT_EXAMPLES) {
      const got = localTaskClassifier.classify({ text: example.text });
      if (!["small-talk", "simple-question"].includes(got.taskType)) continue;
      const marker =
        /```/.test(example.text) ||
        /~{3,}/.test(example.text) ||
        /\w+(Exception|Error|Fault)\b/.test(example.text) ||
        /\b[A-Z]{4,}\b/.test(example.text) ||
        /(^|\s)(\/[\w.@-]+\/)+[\w.-]+\.[a-zA-Z]{1,5}/.test(example.text) ||
        /\bat\s+.+\([^)]+:\d+:\d+\)/.test(example.text) ||
        /Traceback \(most recent call last\)/.test(example.text);
      if (marker) {
        offenders.push(`[${got.taskType}] ${example.text.split("\n")[0]?.slice(0, 70)}`);
      }
    }
    expect(offenders, `light route over a hard marker:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

describe("one weak signal stays below the confidence floor", () => {
  it.each([
    ["what is the default timeout of the worker queue", "simple-question"],
    ["is the cache warm?", "simple-question"],
    ["what does 404 mean?", "simple-question"],
    ["when is the next release?", "simple-question"],
  ])("%s stays below the floor or matches the label", (text, label) => {
    const got = localTaskClassifier.classify({ text });
    const passes = got.confidence < EFFORT_ROUTE_MIN_CONFIDENCE || got.taskType === label;
    expect(passes, `got ${got.taskType} at ${got.confidence}`).toBe(true);
  });

  it("keeps the floor itself between zero and one", () => {
    expect(EFFORT_ROUTE_MIN_CONFIDENCE).toBeGreaterThan(0);
    expect(EFFORT_ROUTE_MIN_CONFIDENCE).toBeLessThan(1);
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

describe("round 2 holdout messages (never in the example set)", () => {
  // Written for this test alone, not present in EFFORT_EXAMPLES. They hold the line the
  // brief calls the one dangerous miss: a failure message read as a light task.
  const holdout: readonly { text: string; taskType: string }[] = [
    {
      text: "Every few hours the sync worker dies with a SegmentationFault, is anyone else seeing this?",
      taskType: "debugging",
    },
    {
      text: "The payments service throws TransactionAbortedError on retries since Tuesday. Thoughts?",
      taskType: "debugging",
    },
    {
      text: "Kubernetes keeps evicting the exporter pods, message says FailedScheduling. What gives?",
      taskType: "debugging",
    },
    {
      text: "Search latency tripled after the index rebuild; any theories?",
      taskType: "debugging",
    },
    {
      text: "The certificate on the api endpoint expired last night and now nothing connects. Ideas?",
      taskType: "debugging",
    },
    {
      text: "We are getting CRASHLoopBackOff on the new worker; how do we chase that down?",
      taskType: "debugging",
    },
  ];

  it("never routes a failure message to a light task", () => {
    const offenders: string[] = [];
    for (const item of holdout) {
      const got = localTaskClassifier.classify({ text: item.text });
      if (["small-talk", "simple-question"].includes(got.taskType)) {
        offenders.push(`[${got.taskType}] ${item.text.slice(0, 70)}`);
      }
    }
    expect(offenders, `light-routed failures:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("routes every holdout failure message to medium effort or higher", () =>
    holdoutDangerousCheck(holdout));

  function holdoutDangerousCheck(items: readonly { text: string; taskType: string }[]): void {
    const misses: string[] = [];
    for (const item of items) {
      const decision = routeEffort({
        classification: localTaskClassifier.classify({ text: item.text }),
        table: EFFORT_ROUTE_TABLE_V1_DEFAULTS,
        supported: ALL_LEVELS,
      });
      const rank = ALL_LEVELS.indexOf(decision.effort);
      if (rank < ALL_LEVELS.indexOf("medium")) {
        misses.push(`[${decision.effort}] ${item.text.slice(0, 70)}`);
      }
    }
    expect(misses, `dangerous holdout misses:\n  ${misses.join("\n  ")}`).toEqual([]);
  }
});

describe("round 3: huge and odd inputs", () => {
  it("never throws, whatever the string", () => {
    const cases: readonly [string, string][] = [
      ["a 375 KB run of two-letter words", "aa ".repeat(125000)],
      ["a 300 KB run of slashes", "/a".repeat(150000)],
      ["the empty string", ""],
      ["one emoji", "🙂"],
      ["100,000 newlines", "\n".repeat(100000)],
      ["a 2 MB message of repeated words", "the quick brown fox jumps over the lazy dog ".repeat(45000)],
    ];
    for (const [name, text] of cases) {
      const got = localTaskClassifier.classify({ text });
      expect(got.taskType, name).toBeDefined();
      expect(got.confidence, name).toBeGreaterThanOrEqual(0);
      expect(got.confidence, name).toBeLessThanOrEqual(1);
    }
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
