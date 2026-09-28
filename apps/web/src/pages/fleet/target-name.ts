import type { FleetTarget, HostLabel } from "@ardurbot/contracts";
import { useLingui } from "@lingui/react/macro";

/** Built-in rows are named here, in the reader's language. The one source of truth for it. */
export function useTargetName(hostLabel: HostLabel | undefined) {
  const { t } = useLingui();
  const mac = hostLabel === "This Mac";
  return (
    target: Pick<FleetTarget, "name" | "builtin"> &
      Partial<Pick<FleetTarget, "connectionId" | "context">>,
  ) =>
    target.builtin === "host"
      ? mac
        ? t`This Mac`
        : t`This computer`
      : target.builtin === "local-docker"
        ? mac
          ? t`Docker engine on this Mac`
          : t`Docker engine on this computer`
        : target.builtin === "default"
          ? t`Default computer`
          : target.connectionId === null && target.context === "default"
            ? mac
              ? t`Docker engine (default context) on this Mac`
              : t`Docker engine (default context) on this computer`
            : target.connectionId === null && target.context === "desktop-linux"
              ? mac
                ? t`Docker Desktop on this Mac`
                : t`Docker Desktop on this computer`
              : target.connectionId === null && target.context === "orbstack"
                ? mac
                  ? t`OrbStack on this Mac`
                  : t`OrbStack on this computer`
                : target.connectionId === null && target.context?.startsWith("colima-")
                  ? mac
                    ? t`Colima (${target.context.slice(7)}) on this Mac`
                    : t`Colima (${target.context.slice(7)}) on this computer`
                  : target.connectionId === null && target.context === "colima"
                    ? mac
                      ? t`Colima (default) on this Mac`
                      : t`Colima (default) on this computer`
                    : target.connectionId === null && target.context?.startsWith("kind-")
                      ? t`kind (${target.context.slice(5)})`
                      : target.name;
}
