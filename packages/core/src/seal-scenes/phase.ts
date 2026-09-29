import type { ThreadMessage } from "@ardurbot/contracts";
import { progressMessageId } from "../events.js";
import type { SealPhase, SealProgress } from "./types.js";

/** A run shows `starting` for its first moments. */
export const SEAL_STARTING_MS = 1_500;
/** A completed run shows `done` this long before the seal rests. */
export const SEAL_DONE_MS = 4_000;

/** What the current work record says the bot is doing. */
export interface SealActivity {
  /** The tool call in progress: a tool name or its work-record line. */
  tool?: string;
  /** Progress through the current plan or task list. */
  plan?: SealProgress;
}

export interface SealPhaseInput {
  /** The run status (`RunStatus`), or `idle` when the bot has no run. */
  status?: string | null;
  /** When the run started, in epoch ms. */
  startedAt?: number | null;
  /** When the run ended, in epoch ms. */
  endedAt?: number | null;
  /** The reader has seen the failed run's error. */
  errorSeen?: boolean;
  activity?: SealActivity | null;
  now?: number;
}

export interface SealPhaseState {
  phase: SealPhase;
  progress?: SealProgress;
  /** When a time-based phase ends; derive again then. */
  until?: number;
}

/** Word forms that mark a search, read or browse tool call. */
const LOOKING_WORDS = new Set([
  "browse",
  "browser",
  "browsing",
  "fetch",
  "fetching",
  "find",
  "finding",
  "glob",
  "grep",
  "lookup",
  "navigate",
  "navigating",
  "read",
  "reading",
  "recall",
  "search",
  "searching",
]);

/** True for a search, read or browse tool call, by name or work-record line. */
export function isSealSearchActivity(tool: string): boolean {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => LOOKING_WORDS.has(word));
}

/** The seal phase for what the UI already knows about a bot's run. */
export function deriveSealPhase(input: SealPhaseInput): SealPhaseState {
  const now = input.now ?? Date.now();
  switch (input.status) {
    case "queued":
    case "leased":
      return { phase: "starting" };
    case "running": {
      if (input.startedAt != null) {
        const age = now - input.startedAt;
        // A start stamped slightly ahead of this clock still counts; a far one does not.
        if (age < SEAL_STARTING_MS && age > -SEAL_STARTING_MS) {
          return { phase: "starting", until: input.startedAt + SEAL_STARTING_MS };
        }
      }
      const { tool, plan } = input.activity ?? {};
      if (tool && isSealSearchActivity(tool)) return { phase: "searching" };
      if (plan && plan.total >= 2) return { phase: "steps", progress: plan };
      return { phase: "thinking" };
    }
    case "waiting_input":
      return { phase: "waiting" };
    case "waiting_takeover":
      return { phase: "paused" };
    case "completed":
      if (input.endedAt != null && now < input.endedAt + SEAL_DONE_MS) {
        return { phase: "done", until: input.endedAt + SEAL_DONE_MS };
      }
      return { phase: "idle" };
    case "failed":
      return { phase: input.errorSeen ? "idle" : "error" };
    default:
      return { phase: "idle" };
  }
}

/**
 * A run's activity from the thread's work record: the tool call at the end of
 * its live message, and its subagents as a task list.
 */
export function sealActivity(
  messages: readonly Pick<ThreadMessage, "id" | "runId" | "blocks">[],
  runId: string,
): SealActivity {
  const liveId = progressMessageId({ runId });
  const tail = messages.find((message) => message.id === liveId)?.blocks.at(-1);
  const tool =
    tail?.kind === "progress"
      ? (tail.pendingToolNames?.at(-1) ?? (tail.activity ? tail.text : undefined))
      : tail?.kind === "steps"
        ? tail.steps.at(-1)?.label
        : undefined;
  const subagents = new Map<string, boolean>();
  for (const message of messages) {
    if (message.runId !== runId) continue;
    for (const block of message.blocks) {
      if (block.kind === "subagent") subagents.set(block.agentId, block.status !== "running");
    }
  }
  const done = [...subagents.values()].filter(Boolean).length;
  return {
    ...(tool ? { tool } : {}),
    ...(subagents.size ? { plan: { done, total: subagents.size } } : {}),
  };
}
