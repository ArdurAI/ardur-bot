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
  return t(failureCategory(id).message, {
    runtime: params.runtime ?? "This runtime",
    bot: params.bot ?? "This bot",
    member: params.member ?? "Worker",
  });
}
