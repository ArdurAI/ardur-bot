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

export const ComputerWorkspaceSaveFailureCategorySchema = z.enum([
  ...ComputerWorkspaceSaveFailureReasonSchema.options,
  "source-not-owned",
  "command-failed",
  "permission-denied",
  "timed-out",
  "socket-missing",
  "engine-not-running",
  "not-reachable",
]);

/** Read legacy reason tokens and reason:category diagnostics without displaying the detail. */
export function computerWorkspaceSaveFailureReason(detail?: string) {
  const [reason, category, extra] = detail?.split(":") ?? [];
  if (
    extra !== undefined ||
    (category !== undefined &&
      !ComputerWorkspaceSaveFailureCategorySchema.safeParse(category).success)
  )
    return null;
  const parsed = ComputerWorkspaceSaveFailureReasonSchema.safeParse(reason);
  return parsed.success ? parsed.data : null;
}

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
    const category = ComputerWorkspaceSaveFailureCategorySchema.safeParse(engineFailureCategory);
    if (category.success) this.engineFailureCategory = category.data;
  }
  get detail() {
    return this.engineFailureCategory
      ? `${this.reason}:${this.engineFailureCategory}`
      : this.reason;
  }
}
