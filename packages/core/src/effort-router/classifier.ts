import type { TaskType } from "@ardurbot/contracts";

/** Where the message came from; it shapes who answers, not how much thinking an answer needs. */
export type EffortTrigger = "person" | "wake" | "handoff" | "bot-message";

/** What a classifier sees: the message plus the little the composer already knows about it. */
export type TaskClassifierInput = {
  text: string;
  hasAttachments?: boolean;
  answersBotQuestion?: boolean;
  trigger?: EffortTrigger;
};

/** What a classifier concludes: a task type, how sure it is, and which signals it used. */
export type TaskClassification = {
  taskType: TaskType;
  confidence: number;
  signals: string[];
};

/**
 * The one interface of the auto-effort framework. Everything above it is a typed table;
 * everything below it is wiring. A classifier must be deterministic and must never do I/O.
 */
export interface TaskClassifier {
  classify(input: TaskClassifierInput): TaskClassification;
}
