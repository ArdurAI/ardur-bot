import type { FailureCategoryId, FailureCategoryParams } from "@ardurbot/contracts";
import { failureCategory } from "@ardurbot/contracts";
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
