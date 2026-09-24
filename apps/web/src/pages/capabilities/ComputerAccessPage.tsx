import type { ComputerNetworkSetting } from "@ardurbot/contracts";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { ComputerSettingsPanel } from "../AccountSettingsOverlay";

export function ComputerAccessPage({ isDeploymentOwner }: { isDeploymentOwner: boolean }) {
  return isDeploymentOwner ? <ComputerSettingsPanel /> : <ComputerList key={selectedSpaceId()} />;
}
function ComputerList() {
  const [computers, setComputers] = useState<ComputerNetworkSetting[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.capabilities
      .settings()
      .then((result) => {
        if (active) setComputers(result.computers);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert">
          <Trans>Could not load computers.</Trans>
        </p>
      ) : null}
      {computers.map((computer) => (
        <div
          key={computer.id}
          className="flex items-center justify-between border-b border-border py-3"
        >
          <span>{computer.name}</span>
          <span className="text-sm text-muted-foreground">{computer.kind}</span>
        </div>
      ))}
    </div>
  );
}
