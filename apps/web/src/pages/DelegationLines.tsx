import type { DelegationRecord } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { rpc } from "../lib/rpc";

export function DelegationLines({
  rootTaskId,
  rows,
}: {
  rootTaskId: string;
  rows: DelegationRecord[];
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(false);
  if (!rows.length) return null;
  const active = rows.some((row) => ["queued", "running", "cancel-requested"].includes(row.status));
  return (
    <div className="ms-7 px-2.5 pb-2 text-xs text-muted-foreground">
      {rows.map((row) => (
        <div key={row.id}>
          {row.requesterName} → {row.actingName} ·{" "}
          <DelegationStatus
            status={
              stopping && ["queued", "running"].includes(row.status)
                ? "cancel-requested"
                : row.status
            }
          />
        </div>
      ))}
      {active ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={stopping || rows.every((row) => !["queued", "running"].includes(row.status))}
          onClick={async () => {
            setStopping(true);
            setError(false);
            try {
              await rpc.delegations.cancel({ rootTaskId });
            } catch {
              setStopping(false);
              setError(true);
            }
          }}
        >
          <Trans>Stop</Trans>
        </Button>
      ) : null}
      {error ? (
        <div role="alert">
          <Trans>Could not stop this task; try again.</Trans>
        </div>
      ) : null}
    </div>
  );
}
function DelegationStatus({ status }: { status: DelegationRecord["status"] }) {
  switch (status) {
    case "queued":
      return <Trans>Queued</Trans>;
    case "running":
      return <Trans>Running</Trans>;
    case "completed":
      return <Trans>Completed</Trans>;
    case "accepted":
      return <Trans>Accepted</Trans>;
    case "failed":
      return <Trans>Failed</Trans>;
    case "cancel-requested":
      return <Trans>Stopping</Trans>;
    case "cancelled":
      return <Trans>Cancelled</Trans>;
  }
}
