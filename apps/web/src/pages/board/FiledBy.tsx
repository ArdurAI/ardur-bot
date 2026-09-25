import type { BoardFiling } from "@ardurbot/contracts/board";
import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";

export function filedByRunPath(filing: Pick<BoardFiling, "botId" | "runId">) {
  return `/app/${encodeURIComponent(filing.botId)}?run=${encodeURIComponent(filing.runId)}`;
}

export function FiledBy({ filing }: { filing: BoardFiling }) {
  const name = filing.botName;
  return (
    <Link className="text-xs text-muted-foreground underline" to={filedByRunPath(filing)}>
      <Trans>Filed by {name}</Trans>
    </Link>
  );
}
