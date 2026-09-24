import type { MemoryDocumentHead, MemoryHistoryRevision } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function MemoryHistory({
  document,
  onChange,
}: {
  document: MemoryDocumentHead;
  onChange: (doc: MemoryDocumentHead) => void;
}) {
  const { t } = useLingui();
  const [items, setItems] = useState<MemoryHistoryRevision[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<MemoryHistoryRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void rpc.memory
      .history({ documentId: document.id })
      .then((page) => {
        if (active) {
          setItems(page.items);
          setCursor(page.nextCursor);
          setSelected(page.items[0] ?? null);
        }
      })
      .catch(() => {
        if (active) setError(t`Could not load history. Retry.`);
      });
    return () => {
      active = false;
    };
  }, [document.id, document.revision, document.gitSync?.status, t]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await rpc.memory.history({ documentId: document.id, cursor });
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setError(t`Could not load history. Retry.`);
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      onChange(
        await rpc.memory.restore({
          documentId: document.id,
          revision: selected.revision,
          expectedRevision: document.revision,
        }),
      );
    } catch {
      setError(t`Could not restore this revision. Reload and try again.`);
    } finally {
      setBusy(false);
    }
  }
  const before = selected
    ? items.find((revision) => revision.revision === selected.revision - 1)
    : undefined;
  return (
    <div
      className="h-80 overflow-auto motion-safe:animate-in motion-safe:fade-in duration-100 motion-reduce:animate-none"
      data-testid="memory-history"
    >
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {items.map((revision) => (
          <Button
            key={revision.revision}
            variant="ghost"
            size="sm"
            onClick={() => setSelected(revision)}
            aria-pressed={selected?.revision === revision.revision}
          >
            <Trans>Revision {revision.revision}</Trans>
            {revision.commitId ? (
              <span className="font-mono text-xs">{revision.commitId.slice(0, 8)}</span>
            ) : null}
          </Button>
        ))}
      </div>
      {cursor ? (
        <Button disabled={busy} variant="ghost" onClick={() => void more()}>
          <Trans>More history</Trans>
        </Button>
      ) : null}
      {selected ? (
        <>
          {selected.gitSync ? (
            <p className="text-xs text-muted-foreground">
              {selected.gitSync.status === "pushed"
                ? t`Pushed`
                : selected.gitSync.status === "failed"
                  ? t`Saved locally. GitHub sync failed.`
                  : t`Saved locally. Sync pending.`}
            </p>
          ) : null}
          <dl className="my-2 grid grid-cols-2 gap-1 text-xs text-muted-foreground">
            <dt>
              <Trans>Author</Trans>
            </dt>
            <dd>
              {selected.author.kind} {selected.author.userId}
            </dd>
            <dt>
              <Trans>Bot</Trans>
            </dt>
            <dd>{selected.author.botId ?? "—"}</dd>
            <dt>
              <Trans>Run</Trans>
            </dt>
            <dd>{selected.runId ?? "—"}</dd>
            <dt>
              <Trans>Model</Trans>
            </dt>
            <dd>
              {selected.model
                ? `${selected.model.provider} · ${selected.model.modelId} · ${selected.model.effort ?? "—"}`
                : "—"}
            </dd>
            {selected.learning ? (
              <>
                <dt>
                  <Trans>Approved by</Trans>
                </dt>
                <dd>{selected.learning.approvingUserId}</dd>
                {selected.learning.grantId ? (
                  <>
                    <dt>
                      <Trans>Learning grant</Trans>
                    </dt>
                    <dd>{selected.learning.grantId}</dd>
                  </>
                ) : null}
                <dt>
                  <Trans>Policy version</Trans>
                </dt>
                <dd>{selected.learning.policyVersion}</dd>
              </>
            ) : null}
            <dt>
              <Trans>Saved</Trans>
            </dt>
            <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
          </dl>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p>
                <Trans>Before</Trans>
              </p>
              <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                {before?.content ??
                  (selected.revision === 1 ? "—" : t`Load more history to compare.`)}
              </pre>
            </div>
            <div>
              <p>
                <Trans>After</Trans>
              </p>
              <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
                {selected.content || "—"}
              </pre>
            </div>
          </div>
          {!selected.deletedAt ? (
            <Button
              className="mt-2"
              disabled={busy || selected.revision === document.revision}
              onClick={() => void restore()}
            >
              <Trans>Restore</Trans>
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
