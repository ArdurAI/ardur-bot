import { describe, expect, it } from "vitest";
import type { ThinkingLevel } from "./domain.js";
import { ThinkingLevelSchema } from "./domain.js";
import {
  AUTO_EFFORT,
  EFFORT_ROUTE_MIN_CONFIDENCE,
  EFFORT_ROUTE_TABLE_V1_DEFAULTS,
  EffortRouteTableV1Schema,
  nearestSupportedEffort,
  TASK_TYPES,
  TaskTypeSchema,
} from "./effort-routing.js";

describe("effort routing table", () => {
  it('reserves "auto" as the selector value that turns routing on', () => {
    expect(AUTO_EFFORT).toBe("auto");
    expect(TaskTypeSchema.safeParse(AUTO_EFFORT).success).toBe(false);
  });

  it("gives every task type a route, and the defaults are that table", () => {
    expect(new Set(Object.keys(EFFORT_ROUTE_TABLE_V1_DEFAULTS.routes))).toEqual(
      new Set(TASK_TYPES),
    );
    expect(EFFORT_ROUTE_TABLE_V1_DEFAULTS.version).toBe(1);
    expect(() => EffortRouteTableV1Schema.parse(EFFORT_ROUTE_TABLE_V1_DEFAULTS)).not.toThrow();
  });

  it("refuses a table with a missing task type or an unknown one", () => {
    const missing = { ...EFFORT_ROUTE_TABLE_V1_DEFAULTS } as Record<string, unknown>;
    const routes = { ...EFFORT_ROUTE_TABLE_V1_DEFAULTS.routes } as Record<string, unknown>;
    delete routes["code-change"];
    missing.routes = routes;
    expect(EffortRouteTableV1Schema.safeParse(missing).success).toBe(false);
    const extra = {
      version: 1,
      routes: {
        ...EFFORT_ROUTE_TABLE_V1_DEFAULTS.routes,
        "far-future": { effort: "low", turn: "light" },
      },
    };
    expect(EffortRouteTableV1Schema.safeParse(extra).success).toBe(false);
    expect(EffortRouteTableV1Schema.safeParse({ version: 2, routes: {} }).success).toBe(false);
  });

  it("refuses a route with a bad effort or turn", () => {
    for (const bad of [
      { effort: "huge", turn: "light" },
      { effort: "low", turn: "instant" },
      { effort: "low" },
    ]) {
      expect(
        EffortRouteTableV1Schema.safeParse({
          version: 1,
          routes: { ...EFFORT_ROUTE_TABLE_V1_DEFAULTS.routes, unknown: bad },
        }).success,
      ).toBe(false);
    }
  });

  it("keeps the confidence floor inside (0, 1)", () => {
    expect(EFFORT_ROUTE_MIN_CONFIDENCE).toBeGreaterThan(0);
    expect(EFFORT_ROUTE_MIN_CONFIDENCE).toBeLessThan(1);
  });
});

describe("nearest supported effort", () => {
  it("answers the exact match when it is supported", () => {
    expect(nearestSupportedEffort("high", ["low", "high", "max"])).toBe("high");
  });

  it("takes the supported level below when nothing above is close enough", () => {
    // The only levels below the wanted one are nearer than anything else.
    expect(nearestSupportedEffort("high", ["off", "minimal", "low"])).toBe("low");
  });

  it("takes the supported level above when the wanted one is missing", () => {
    expect(nearestSupportedEffort("low", ["medium", "high"])).toBe("medium");
    expect(nearestSupportedEffort("minimal", ["low", "medium"])).toBe("low");
  });

  it("breaks a distance tie toward the higher level", () => {
    expect(nearestSupportedEffort("medium", ["low", "high"])).toBe("high");
    expect(nearestSupportedEffort("medium", ["high", "low"])).toBe("high");
  });

  it("answers off only when nothing else is supported", () => {
    expect(nearestSupportedEffort("high", ["off"])).toBe("off");
    expect(nearestSupportedEffort("medium", ["off", "xhigh"])).toBe("xhigh");
  });

  it("answers null for an empty list", () => {
    expect(nearestSupportedEffort("high", [])).toBe(null);
  });

  it("treats every thinking level by rank", () => {
    const ranks: readonly ThinkingLevel[] = ThinkingLevelSchema.options;
    expect(nearestSupportedEffort("off", ranks.slice(1))).toBe("minimal");
    expect(nearestSupportedEffort("max", ["off", "high"])).toBe("high");
  });
});
