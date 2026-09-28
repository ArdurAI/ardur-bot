import type { CommandBlock, MessageBlock } from "@ardurbot/contracts";

export type ActivityLabel =
  | "narration"
  | "tool-activity"
  | "peer-delivery"
  | "delegation"
  | "unavailable";

export type ActivityOutcome = "pending" | "success" | "failure" | "unknown" | "interrupted";

export interface ActivityEvidence {
  label: ActivityLabel;
  title: string;
  timestamp?: string;
  durationMs?: number;
  outcome?: ActivityOutcome;
}

export function mapMessageBlockToActivity(block: MessageBlock): ActivityEvidence {
  if (block.kind === "text") {
    return { label: "narration", title: block.text, outcome: "success" };
  }

  if (block.kind === "progress") {
    if (block.activity) {
      return {
        label: "tool-activity",
        title: block.text,
        outcome: "pending",
      };
    }
    return { label: "narration", title: block.text, outcome: "pending" };
  }

  if (block.kind === "steps") {
    const title = block.steps.map((s) => `${s.label} (${s.count})`).join(", ") || "Steps";
    return {
      label: "tool-activity",
      title,
      durationMs: block.durationMs,
      outcome: block.durationMs !== undefined ? "success" : "pending",
    };
  }

  if (block.kind === "command") {
    return {
      label: "tool-activity",
      title: block.command.command ?? "Command",
      timestamp: block.command.startedAt ?? undefined,
      durationMs: block.command.durationMs ?? undefined,
      outcome: mapCommandOutcome(block.command),
    };
  }

  if (block.kind === "handoff") {
    return { label: "delegation", title: block.text, outcome: "success" };
  }

  if (block.kind === "subagent") {
    return {
      label: "delegation",
      title: block.task,
      outcome:
        block.status === "completed"
          ? "success"
          : block.status === "failed"
            ? "failure"
            : "pending",
    };
  }

  if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
    return { label: "peer-delivery", title: "Peer message", outcome: "success" };
  }

  return { label: "unavailable", title: "Unavailable", outcome: "unknown" };
}

function mapCommandOutcome(command: CommandBlock): ActivityOutcome {
  switch (command.outcome) {
    case "waiting":
    case "running":
      return "pending";
    case "completed":
      return command.exitCode === 0 ? "success" : "failure";
    case "cancelled":
      return "interrupted";
    case "unknown":
      return "unknown";
    default:
      return "unknown";
  }
}
