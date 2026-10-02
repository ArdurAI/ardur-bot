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
  constructor(
    readonly reason: ComputerWorkspaceSaveFailureReason,
    readonly engineFailureCategory?: string,
  ) {
    super(reason);
    this.name = "ComputerWorkspaceSaveError";
  }
}
