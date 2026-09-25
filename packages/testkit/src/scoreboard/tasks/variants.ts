import { countAssembledRequest } from "../replay/protocol.js";
import type { TaskContract } from "./catalog.js";
import { immutable } from "./catalog.js";

export interface TaskVariant {
  history: "short" | "long";
  tools: "local" | "remote";
  capacity: 16000 | 128000 | 1000000;
}

/** Budget simulation only: never changes or asserts a provider's real context window. */
export function simulateCapacity(
  request: unknown,
  capacity: TaskVariant["capacity"],
  outputReserve: number,
) {
  if (
    ![16000, 128000, 1000000].includes(capacity) ||
    !Number.isSafeInteger(outputReserve) ||
    outputReserve < 0
  )
    throw new Error("Invalid synthetic capacity scenario");
  const count = countAssembledRequest(request);
  return {
    ...count,
    capacity,
    outputReserve,
    fits: count.tokens + outputReserve <= capacity,
    kind: "synthetic-budget-simulation" as const,
    actualRouteCapacity: null,
  };
}

export function taskMaterial(task: TaskContract, variant: TaskVariant) {
  if (variant.tools === "remote" && !task.remoteTools) throw new Error("Remote tools unsupported");
  if (![16000, 128000, 1000000].includes(variant.capacity))
    throw new Error("Unknown synthetic capacity");
  if (!["short", "long"].includes(variant.history) || !["local", "remote"].includes(variant.tools))
    throw new Error("Unknown task variant");
  return immutable({
    taskId: task.id,
    prompt: task.prompt,
    files: task.files,
    initialState: task.initialState,
    allowedTools: task.allowedTools,
    consent: task.consent,
    history:
      variant.history === "short"
        ? []
        : Array.from({ length: 204 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content:
              index === 102
                ? `Archived attachment: ${"synthetic context ".repeat(2600)}`
                : `Archived turn ${index}. Current input files supersede earlier notes.`,
          })),
    capacity: {
      tokens: variant.capacity,
      kind: "synthetic-test-configuration",
      source: "task-variants-v1",
      actualRouteCapacity: null,
    },
    scope: {
      memory: "fixture-only",
      delegation: "accepted-input-results-only",
      backgroundLearning: false,
    },
  });
}
