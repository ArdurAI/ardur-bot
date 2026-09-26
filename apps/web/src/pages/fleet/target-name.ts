import type { FleetTarget, HostLabel } from "@ardurbot/contracts";
import { useLingui } from "@lingui/react/macro";

/** Built-in rows are named here, in the reader's language. The one source of truth for it. */
export function useTargetName(hostLabel: HostLabel | undefined) {
  const { t } = useLingui();
  const mac = hostLabel === "This Mac";
  return (target: Pick<FleetTarget, "name" | "builtin">) =>
    target.builtin === "host"
      ? mac
        ? t`This Mac`
        : t`This computer`
      : target.builtin === "local-docker"
        ? mac
          ? t`Docker on this Mac`
          : t`Docker on this computer`
        : target.builtin === "default"
          ? t`Default computer`
          : target.name;
}
