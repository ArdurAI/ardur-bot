import type { CapabilityPreferences, CapabilitySettings } from "@ardurbot/contracts";
import { Button, Skeleton } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import type { SettingsPageProps } from "../settings-types";
import { CapabilitiesPage } from "./CapabilitiesPage";
import { ComputerAccessPage } from "./ComputerAccessPage";

export default function CapabilitiesSettings(props: SettingsPageProps) {
  const spaceId = selectedSpaceId();
  return (
    <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2">
      <Settings key={spaceId} {...props} spaceId={spaceId} />
    </div>
  );
}
function Settings({
  navigate,
  spaceId,
  isDeploymentOwner,
  onBusyChange,
}: SettingsPageProps & { spaceId: string | null }) {
  const [showComputers, setShowComputers] = useState(false);
  const [data, setData] = useState<CapabilitySettings | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    const result = await rpc.capabilities.settings(undefined, { context: { spaceId } });
    setData(result);
    setError(false);
  }, [spaceId]);
  useEffect(() => {
    let active = true;
    void rpc.capabilities
      .settings(undefined, { context: { spaceId } })
      .then((result) => {
        if (active) setData(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [spaceId]);
  useEffect(() => {
    if (!data?.computers.some((computer) => computer.pending)) return;
    const timer = setInterval(() => {
      void refresh().catch(() => setError(true));
    }, 5000);
    return () => clearInterval(timer);
  }, [data, refresh]);
  if (error && !data)
    return (
      <div role="alert">
        <Trans>Could not load capabilities.</Trans>
        <Button onClick={() => void refresh().catch(() => setError(true))}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  if (!data) return <Skeleton className="h-40 w-full" />;
  if (showComputers)
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setShowComputers(false)}>
          <Trans>Back to capabilities</Trans>
        </Button>
        <ComputerAccessPage />
      </div>
    );
  return (
    <CapabilitiesPage
      {...data}
      onBusyChange={onBusyChange}
      onChange={async (patch: Partial<CapabilityPreferences>) => {
        const settings = await rpc.capabilities.configure(patch, { context: { spaceId } });
        setData((current) => (current ? { ...current, settings } : current));
      }}
      onNetworkChange={async (computerId, networkEgress, confirmed) => {
        await rpc.capabilities.network(
          { computerId, networkEgress, confirmed },
          { context: { spaceId } },
        );
        await refresh();
      }}
      onOpenComputers={() => (isDeploymentOwner ? navigate("computer") : setShowComputers(true))}
      onOpenCustomize={() => navigate("skills")}
    />
  );
}
