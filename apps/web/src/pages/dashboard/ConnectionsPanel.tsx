import type { ConnectionOverview } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { rpc } from "../../lib/rpc";
import type { PanelActions, PanelContext } from "./panels";

export async function load(context: PanelContext) {
  const rows = await rpc.dashboard.connections(undefined, {
    signal: context.signal,
    context: { spaceId: context.spaceId },
  });
  return rows.length ? rows : null;
}
export default function ConnectionsPanel({
  data,
  openSettings,
}: { data: ConnectionOverview[] } & PanelActions) {
  const { t } = useLingui();
  const states = {
    connected: t`Connected`,
    "needs-sign-in": t`Needs sign-in`,
    "not-connected": t`Not connected`,
    error: t`Error`,
  };
  return (
    <div className="space-y-1">
      {data.map((row) => (
        <Button
          key={`${row.kind}:${row.id}`}
          variant="ghost"
          className="h-auto w-full justify-between gap-3 whitespace-normal text-start"
          onClick={() =>
            openSettings(
              row.kind === "device"
                ? "devices"
                : row.kind === "channel"
                  ? "messaging"
                  : row.kind === "mcp"
                    ? "mcp"
                    : "integrations",
            )
          }
        >
          <span>{row.name}</span>
          <span className="text-muted-foreground">{states[row.state]}</span>
        </Button>
      ))}
    </div>
  );
}
