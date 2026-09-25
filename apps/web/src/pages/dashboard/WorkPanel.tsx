import type { BoardWork } from "@ardurbot/contracts/board";
import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";
import { rpc } from "../../lib/rpc";
import { FiledBy } from "../board/FiledBy";
import type { PanelActions, PanelContext } from "./panels";

export async function load({ signal, spaceId }: PanelContext) {
  const work = await rpc.board.work({}, { signal, context: { spaceId } });
  try {
    const outcomes = await rpc.board.filingOutcomes({}, { signal, context: { spaceId } });
    return { ...work, filingOutcomes: outcomes.bots, outcomesUnavailable: false };
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    return {
      ...work,
      filingOutcomes: [] as Awaited<ReturnType<typeof rpc.board.filingOutcomes>>["bots"],
      outcomesUnavailable: true,
    };
  }
}
type WorkData = BoardWork & {
  filingOutcomes: Awaited<ReturnType<typeof load>>["filingOutcomes"];
  outcomesUnavailable?: boolean;
};
export default function WorkPanel({ data, openSettings }: { data: WorkData } & PanelActions) {
  if (!data.workspace)
    return (
      <div className="space-y-3 text-sm">
        <Button variant="ghost" onClick={() => openSettings("boards")}>
          <Trans>Set up a board</Trans>
        </Button>
        <OutcomeLine data={data} />
      </div>
    );
  return (
    <div className="space-y-3 text-sm">
      <Link
        className="underline"
        to={`/app/board?workspace=${encodeURIComponent(data.workspace.id)}`}
      >
        {data.workspace.name}
      </Link>
      <div className="flex flex-wrap gap-4">
        <span>
          <Trans>Ready</Trans>: {data.ready}
        </span>
        <span>
          <Trans>In progress</Trans>: {data.inProgress}
        </span>
        <span>
          <Trans>Blocked</Trans>: {data.blocked}
        </span>
      </div>
      {data.items.length ? (
        <ul className="space-y-2">
          {data.items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline gap-2">
              <Link
                className="underline"
                to={`/app/board?workspace=${encodeURIComponent(data.workspace!.id)}&item=${encodeURIComponent(item.id)}`}
              >
                {item.title}
              </Link>
              {item.filedBy ? <FiledBy filing={item.filedBy} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          <Trans>No ready work</Trans>
        </p>
      )}
      <OutcomeLine data={data} />
    </div>
  );
}
function OutcomeLine({ data }: { data: WorkData }) {
  if (data.outcomesUnavailable)
    return (
      <p className="text-muted-foreground">
        <Trans>Board outcomes are unavailable right now.</Trans>
      </p>
    );
  return <FilingOutcomes rows={data.filingOutcomes} />;
}
function FilingOutcomes({ rows }: { rows: WorkData["filingOutcomes"] }) {
  return rows.map((row) => (
    <p key={row.botId}>
      <Trans>
        {row.name} filed {row.filed}: {row.done} done, {row.open} open, {row.other} closed without
        being completed.
      </Trans>
    </p>
  ));
}
