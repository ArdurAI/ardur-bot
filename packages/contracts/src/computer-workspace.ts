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

/** Only reason/category may cross logging or UI boundaries; cause stays local. */
export class ComputerWorkspaceSaveError extends Error {
  readonly engineFailureCategory?: string;
  constructor(
    readonly reason: ComputerWorkspaceSaveFailureReason,
    engineFailureCategory?: string,
    options?: ErrorOptions,
  ) {
    super(reason, options);
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
