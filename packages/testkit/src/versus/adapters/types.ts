import type { OutcomeObservation } from "../../scoreboard/graders/outcome.js";
import type { TaskContract } from "../../scoreboard/tasks/catalog.js";
import type { Budget } from "../budget.js";
import type { Product } from "../manifest.js";

export type EventKind =
  | "admission"
  | "provider-request"
  | "content"
  | "tool-intent"
  | "approval-decision"
  | "effect-receipt"
  | "terminal"
  | "usage"
  | "diagnostic";
export interface VersusEvent {
  sequence: number;
  trialId: string;
  kind: EventKind;
  source:
    | "application-database"
    | "application-rpc"
    | "provider-gateway"
    | "product-stdout"
    | "product-process"
    | "effect-broker"
    | "scripted-double";
  clock: "monotonic" | "virtual";
  at: number;
  data: Record<string, unknown>;
}
export type Emit = (
  kind: EventKind,
  source: VersusEvent["source"],
  data: Record<string, unknown>,
) => void;
export interface TrialContext {
  id: string;
  pairId: string;
  task: TaskContract;
  workspace: string;
  stateDirectory: string;
  budget: Budget;
  providerUrl: string;
  /** Controller-owned revocation; it does not establish product cancellation or stopped billing. */
  revokeProvider: () => void;
  brokerUrl: string;
  emit: Emit;
  signal: AbortSignal;
}
export interface TrialArtifacts {
  observation: OutcomeObservation;
  outcomeReason: string;
  userTtft: null;
  userTtftMissingReason: string;
  sessionId: string | null;
}
export interface VersusAdapter {
  product: Product;
  inspect(): Promise<Record<string, unknown>>;
  prepare(context: TrialContext): Promise<void>;
  submit(): Promise<void>;
  resume(sessionId: string): Promise<void>;
  cancel(): Promise<void>;
  collect(): Promise<TrialArtifacts>;
  destroy(): Promise<void>;
}
