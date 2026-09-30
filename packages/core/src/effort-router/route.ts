import type { EffortRouteTableV1, TaskType, ThinkingLevel } from "@ardurbot/contracts";
import { EFFORT_ROUTE_MIN_CONFIDENCE, nearestSupportedEffort } from "@ardurbot/contracts";
import type { TaskClassification } from "./classifier.js";

/** The decision auto effort makes for one message: which route won and how it is honoured. */
export type EffortRouteDecision = {
  effort: ThinkingLevel;
  turn: "light" | "normal";
  taskType: TaskType;
  reason: string;
};

/**
 * Turn a classification into a route on the model the message will run on. A classification
 * below the confidence floor reads as `unknown`, and the table's effort is snapped to the
 * nearest level the model supports.
 */
export function routeEffort(input: {
  classification: TaskClassification;
  table: EffortRouteTableV1;
  supported: readonly ThinkingLevel[];
}): EffortRouteDecision {
  const { classification, table, supported } = input;
  const confident = classification.confidence >= EFFORT_ROUTE_MIN_CONFIDENCE;
  const taskType: TaskType = confident ? classification.taskType : "unknown";
  const route = table.routes[taskType];
  if (route === undefined) {
    throw new Error(`the route table has no route for ${taskType}`);
  }
  const effort = nearestSupportedEffort(route.effort, supported);
  if (effort === null) {
    throw new Error("routeEffort needs at least one supported thinking level");
  }
  const by = confident ? "" : " (below the confidence floor)";
  return {
    effort,
    turn: route.turn,
    taskType,
    reason: `${taskType}${by} routes to ${route.effort}, nearest supported is ${effort}`,
  };
}
