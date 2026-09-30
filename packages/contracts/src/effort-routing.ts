import { z } from "zod";
import type { ThinkingLevel } from "./domain.js";
import { ThinkingLevelSchema } from "./domain.js";

/** The thinking selector value that means "decide the effort per message from its task type". */
export const AUTO_EFFORT = "auto";

/** The kinds of work a message can ask for. To add one, add it here and give it a route below. */
export const TaskTypeSchema = z.enum([
  "small-talk",
  "simple-question",
  "writing",
  "summary",
  "code-change",
  "debugging",
  "review",
  "planning",
  "research",
  "data",
  "operations",
  "unknown",
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

/** Every task type, in table order. */
export const TASK_TYPES: readonly TaskType[] = TaskTypeSchema.options;

/** How much thinking a task gets, and how long the bot's turn may run. */
export const EffortRouteSchema = z.object({
  effort: ThinkingLevelSchema,
  turn: z.enum(["light", "normal"]),
});
export type EffortRoute = z.infer<typeof EffortRouteSchema>;

/**
 * The versioned routing table. `routes` names every task type exactly once: a table with a
 * missing or unknown task type is refused, not defaulted. The version changes only when a
 * route changes meaning; a new task type keeps the version and gets a route.
 */
export const EffortRouteTableV1Schema = z.object({
  version: z.literal(1),
  routes: z.strictObject(
    Object.fromEntries(TASK_TYPES.map((taskType) => [taskType, EffortRouteSchema])),
  ),
});
export type EffortRouteTableV1 = z.infer<typeof EffortRouteTableV1Schema>;

/**
 * Defaults live here, nowhere else. Chat answers fast: greetings and quick facts get little
 * thinking and a light turn. Work that rewards deliberation — code, review, debugging,
 * planning, research — gets high effort. Everything uncertain lands on medium.
 */
export const EFFORT_ROUTE_TABLE_V1_DEFAULTS: EffortRouteTableV1 = EffortRouteTableV1Schema.parse({
  version: 1,
  routes: {
    "small-talk": { effort: "minimal", turn: "light" },
    "simple-question": { effort: "low", turn: "light" },
    summary: { effort: "low", turn: "normal" },
    writing: { effort: "medium", turn: "normal" },
    data: { effort: "medium", turn: "normal" },
    operations: { effort: "medium", turn: "normal" },
    "code-change": { effort: "high", turn: "normal" },
    review: { effort: "high", turn: "normal" },
    debugging: { effort: "high", turn: "normal" },
    planning: { effort: "high", turn: "normal" },
    research: { effort: "high", turn: "normal" },
    unknown: { effort: "medium", turn: "normal" },
  },
});

/**
 * A classification weaker than this reads as `unknown` and takes the unknown route, so a
 * faint guess cannot spend a work-level budget on a chat message — or a chat budget on work.
 */
export const EFFORT_ROUTE_MIN_CONFIDENCE = 0.6;

/** The thinking levels from least to most; the distance between ranks is what "nearest" means. */
const EFFORT_RANKS: readonly ThinkingLevel[] = ThinkingLevelSchema.options;

/**
 * The supported level closest in rank to the wanted one; on a tie the higher one, because a
 * little extra thinking costs seconds while too little can cost the answer. `off` is returned
 * only when nothing else is supported, and an empty list answers null.
 */
export function nearestSupportedEffort(
  wanted: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel | null {
  if (supported.length === 0) return null;
  const usable = supported.filter((level) => level !== "off");
  const candidates = usable.length > 0 ? usable : supported;
  const wantedRank = EFFORT_RANKS.indexOf(wanted);
  let best: ThinkingLevel | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of candidates) {
    const distance = Math.abs(EFFORT_RANKS.indexOf(level) - wantedRank);
    const closer = distance < bestDistance;
    const tieButHigher =
      distance === bestDistance &&
      best !== null &&
      EFFORT_RANKS.indexOf(level) > EFFORT_RANKS.indexOf(best);
    if (best === null || closer || tieButHigher) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}
