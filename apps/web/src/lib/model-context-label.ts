import type { ModelContextWindowSource } from "@ardurbot/contracts";
import { t } from "@lingui/core/macro";

export function modelContextLabel(source: ModelContextWindowSource): string {
  if (source === "default") return t`Context limit (estimated)`;
  if (source === "catalog") return t`Context limit (from the provider)`;
  return t`Context limit`;
}
