import { createHash } from "node:crypto";
import {
  GOAL_BOARD_ACCEPTED,
  GOAL_BOARD_COMPLETED,
  type GoalBoardTransition,
} from "@ardurbot/contracts";

export function goalBoardHash(key: string) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function goalBoardMarker(hash: string) {
  return `[Goal ${hash}]`;
}

/** Marker, required words, and a same-app result path. No model text or credentials. */
export function goalBoardCommentText(
  transition: GoalBoardTransition,
  resultPath: string,
  hash: string,
) {
  const label = transition === "accepted" ? GOAL_BOARD_ACCEPTED : GOAL_BOARD_COMPLETED;
  return `${goalBoardMarker(hash)}\n${label}\n${resultPath}`.slice(0, 500);
}

export function goalBoardMetadataName(hash: string) {
  return `ardur_gd_${hash}`;
}

export type GoalBoardLedger = {
  generation: number;
  commented: boolean;
  close: "open" | "closed" | "already-closed" | "left-open";
};

const CLOSE_CODE = {
  open: "x0",
  closed: "x1",
  "already-closed": "x2",
  "left-open": "x3",
} as const;

export function formatGoalBoardLedger(ledger: GoalBoardLedger) {
  return `${ledger.generation}:${ledger.commented ? "c1" : "c0"}:${CLOSE_CODE[ledger.close]}`;
}

export function parseGoalBoardLedger(value: unknown): GoalBoardLedger | null {
  if (typeof value !== "string") return null;
  const match = /^([1-9][0-9]{0,8}):(c0|c1):(x0|x1|x2|x3)$/.exec(value);
  if (!match) return null;
  const close = ({ x0: "open", x1: "closed", x2: "already-closed", x3: "left-open" } as const)[
    match[3] as "x0" | "x1" | "x2" | "x3"
  ];
  return {
    generation: Number(match[1]),
    commented: match[2] === "c1",
    close,
  };
}

export function goalBoardMetadataArg(hash: string, ledger: GoalBoardLedger) {
  return `${goalBoardMetadataName(hash)}=${formatGoalBoardLedger(ledger)}`;
}
