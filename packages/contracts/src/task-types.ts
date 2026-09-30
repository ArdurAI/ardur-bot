import { z } from "zod";

/** Shared task vocabulary; independent of runtime and message schemas. */
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
export const TASK_TYPES: readonly TaskType[] = TaskTypeSchema.options;
