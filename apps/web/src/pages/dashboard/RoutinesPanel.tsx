import type { RoutineOverview } from "@ardurbot/contracts";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "react-router-dom";
import { rpc } from "../../lib/rpc";
import type { PanelContext } from "./panels";

export async function load(context: PanelContext) {
  const value = await rpc.routines.overview(undefined, {
    signal: context.signal,
    context: { spaceId: context.spaceId },
  });
  return value.next.length || value.recent.length ? value : null;
}
export default function RoutinesPanel({ data }: { data: RoutineOverview }) {
  const { t } = useLingui();
  const status = (value: string) =>
    value === "completed" ? t`Completed` : value === "cancelled" ? t`Cancelled` : t`Failed`;
  return (
    <div className="space-y-3 text-sm">
      <h3 className="text-muted-foreground">
        <Trans>Next</Trans>
      </h3>
      {!data.next.length ? (
        <p>
          <Trans>No scheduled runs</Trans>
        </p>
      ) : null}
      {data.next.map((row) => (
        <Link
          key={row.id}
          className="flex justify-between gap-3 hover:underline"
          to={`/app/${row.botId}?routine=${row.id}`}
        >
          <span>{row.name}</span>
          <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time>
        </Link>
      ))}
      <h3 className="text-muted-foreground">
        <Trans>Recent</Trans>
      </h3>
      {!data.recent.length ? (
        <p>
          <Trans>No results</Trans>
        </p>
      ) : null}
      {data.recent.map((row) => (
        <Link
          key={row.runId}
          className="flex flex-wrap justify-between gap-2 hover:underline"
          to={`/app/${row.botId}?routine=${row.id}`}
        >
          <span>{row.name}</span>
          <span>{status(row.status)}</span>
          <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time>
        </Link>
      ))}
    </div>
  );
}
