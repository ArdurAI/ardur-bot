import type { CapabilityPreferences, CapabilitySettings } from "@ardurbot/contracts";
import { Button, Skeleton } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { CapabilitiesPage } from "./CapabilitiesPage";

type Props = { navigate: (section: "computer" | "customize") => void };
export default function CapabilitiesSettings(props: Props) {
  const spaceId = selectedSpaceId();
  return <Settings key={spaceId} {...props} spaceId={spaceId} />;
}
function Settings({ navigate, spaceId }: Props & { spaceId: string | null }) {
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
  return (
    <CapabilitiesPage
      {...data}
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
      onOpenComputers={() => navigate("computer")}
      onOpenCustomize={() => navigate("customize")}
    />
  );
}
