import { z } from "zod";

export const ComputerWorkspaceSaveFailureReasonSchema = z.enum([
  "source-not-running",
  "source-missing",
  "engine-unreachable",
  "too-large",
  "save-failed",
]);
export type ComputerWorkspaceSaveFailureReason = z.infer<
  typeof ComputerWorkspaceSaveFailureReasonSchema
>;

/** Safe diagnostics only: never retain provider output or a raw cause. */
export class ComputerWorkspaceSaveError extends Error {
  readonly engineFailureCategory?: string;
  constructor(
    readonly reason: ComputerWorkspaceSaveFailureReason,
    engineFailureCategory?: string,
  ) {
    super(reason);
    this.name = "ComputerWorkspaceSaveError";
    if (
      engineFailureCategory &&
      [
        ...ComputerWorkspaceSaveFailureReasonSchema.options,
        "command-failed",
        "permission-denied",
        "timed-out",
        "socket-missing",
        "engine-not-running",
        "not-reachable",
      ].includes(engineFailureCategory)
    )
      this.engineFailureCategory = engineFailureCategory;
  }
}
