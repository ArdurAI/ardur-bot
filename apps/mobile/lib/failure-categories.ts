import type { FailureCategoryId, FailureCategoryParams, RuntimeProblem } from "@ardurbot/contracts";
import { FailureCategoryIdSchema, failureCategory, runtimeNames } from "@ardurbot/contracts";
import { t } from "./i18n";

/**
 * A failure-category sentence in the active locale. The catalogs key on the table's
 * English sentence (packages/contracts/src/failure-categories.ts), so a category added to
 * the table renders here as soon as its catalog entries exist.
 */
export function failureCategoryText(
  id: FailureCategoryId,
  params: FailureCategoryParams = {},
): string {
  // The table's default sentences name the runtime only.
  return t(failureCategory(id).message, {
    ...params,
    runtime: params.runtime ?? t("This runtime"),
  });
}

/**
 * What a failed run's notice says: the category's sentence in the active locale when the
 * failure was classified, else the reason as it was recorded.
 */
export function runtimeProblemText(problem: RuntimeProblem): string {
  const category = FailureCategoryIdSchema.safeParse(problem.reasonId);
  return category.success
    ? failureCategoryText(category.data, { runtime: runtimeNames[problem.pin.runtimeKind] })
    : problem.reason;
}
