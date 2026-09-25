import type { LearningJourneyEntry } from "@ardurbot/contracts";
import { learningJourneyLabel } from "@ardurbot/contracts";
import { LOCAL_IMPORT_TOOL_NAMES } from "@ardurbot/contracts/local-import";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { LearningObservations } from "./LearningObservation";

export function LearningTimeline({
  botId,
  openProposal,
}: {
  botId?: string;
  openProposal: (id: string) => void;
}) {
  const { t } = useLingui();
  const [entries, setEntries] = useState<LearningJourneyEntry[]>([]);
  const [selected, setSelected] = useState<LearningJourneyEntry | null>(null);
  const [revisionContent, setRevisionContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void rpc.learning
      .journey({ botId })
      .then((value) => {
        if (active) {
          setEntries(value);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [botId, retry]);
  useEffect(() => {
    setRevisionContent(null);
    if (!selected?.documentId || !selected.revisionId) return;
    let active = true;
    const revision = Number(selected.revisionId.split(":").at(-1));
    void rpc.memory
      .history({
        documentId: selected.documentId,
        cursor: revision + 1,
        limit: 1,
      })
      .then((page) => {
        const item = page.items.find((r) => r.revision === revision);
        if (active) {
          setRevisionContent(item?.content ?? null);
          setError(!item);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [selected, retry]);
  return (
    <div className="space-y-3">
      {error ? (
        <div role="alert">
          <Trans>Could not load timeline.</Trans>
          <Button onClick={() => setRetry((n) => n + 1)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      <ol className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="rounded-lg border p-3 text-sm">
            <p>
              {entry.importedFrom
                ? entry.action === "import-removed"
                  ? t`Removed import from ${LOCAL_IMPORT_TOOL_NAMES[entry.importedFrom]}`
                  : t`Imported from ${LOCAL_IMPORT_TOOL_NAMES[entry.importedFrom]}`
                : learningJourneyLabel(entry.action)}{" "}
              · <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
            </p>
            {entry.proposalId ? (
              <Button variant="ghost" onClick={() => openProposal(entry.proposalId!)}>
                <Trans>Proposal</Trans>
              </Button>
            ) : null}
            {entry.revisionId && entry.documentId ? (
              <Button variant="ghost" onClick={() => setSelected(entry)}>
                <Trans>Revision and observations</Trans> {entry.revisionId}
              </Button>
            ) : null}
            {entry.grantId ? (
              <p>
                <Trans>Grant</Trans>: {entry.grantId}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {revisionContent !== null ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{revisionContent}</pre>
      ) : null}
      {selected?.revisionId && selected.documentId ? (
        <LearningObservations
          documentId={selected.documentId}
          revision={Number(selected.revisionId.split(":").at(-1))}
        />
      ) : null}
    </div>
  );
}
