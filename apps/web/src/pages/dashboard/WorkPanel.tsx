import type { BoardWork } from "@ardurbot/contracts/board";
import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";
import { rpc } from "../../lib/rpc";
import { FiledBy } from "../board/FiledBy";
import type { PanelActions, PanelContext } from "./panels";

export function load({ signal, spaceId }: PanelContext) {
  return rpc.board.work({}, { signal, context: { spaceId } });
}
export default function WorkPanel({ data, openSettings }: { data: BoardWork } & PanelActions) {
  if (!data.workspace)
    return (
      <Button variant="ghost" onClick={() => openSettings("boards")}>
        <Trans>Set up a board</Trans>
      </Button>
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
    </div>
  );
}
