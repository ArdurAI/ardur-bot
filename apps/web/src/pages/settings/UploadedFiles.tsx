import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

type FilePage = Awaited<ReturnType<typeof rpc.artifacts.uploaded>>;
export function UploadedFiles() {
  const { t, i18n } = useLingui();
  const [files, setFiles] = useState<FilePage["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async (next?: string) => {
    setBusy(true);
    setError(false);
    try {
      const page = await rpc.artifacts.uploaded({ cursor: next });
      setFiles((current) => (next ? [...current, ...page.items] : page.items));
      setCursor(page.cursor);
      setLoaded(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function remove(id: string) {
    setBusy(true);
    setError(false);
    try {
      await rpc.artifacts.deleteUploaded({ artifactId: id });
      setFiles((current) => current.filter((file) => file.id !== id));
      setConfirm(null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 py-3" aria-busy={busy}>
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          <Trans>Could not update uploaded files.</Trans>{" "}
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {loaded && !files.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No uploaded files</Trans>
        </p>
      ) : null}
      <ul className="space-y-3">
        {files.map((file) => (
          <li key={file.id} className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <p className="break-all">{file.name}</p>
              <p className="text-xs text-muted-foreground">
                {t`${file.size} bytes`} ·{" "}
                <time dateTime={file.createdAt}>
                  {new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
                    new Date(file.createdAt),
                  )}
                </time>
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant={confirm === file.id ? "destructive" : "outline"}
                disabled={busy}
                aria-label={
                  confirm === file.id ? t`Confirm delete ${file.name}` : t`Delete ${file.name}`
                }
                onClick={() => (confirm === file.id ? void remove(file.id) : setConfirm(file.id))}
              >
                {confirm === file.id ? <Trans>Confirm delete</Trans> : <Trans>Delete</Trans>}
              </Button>
              {confirm === file.id ? (
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
                  <Trans>Cancel</Trans>
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {cursor ? (
        <Button variant="outline" disabled={busy} onClick={() => void load(cursor)}>
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </div>
  );
}
