import type { McpDiagnostics, McpServer } from "@ardurbot/contracts";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { AlertTriangle, Terminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { desktopBridge } from "../../lib/desktop";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { EmptyList, PageError } from "./CustomizeControls";
import { ensureCustomizationHost } from "./native";

type Preview = Awaited<ReturnType<typeof rpc.developer.preview>>;
export function DeveloperConfigEditor({
  onClose,
  onApplied,
}: {
  onClose(): void;
  onApplied(): void;
}) {
  const { t } = useLingui();
  const [config, setConfig] = useState({ json: "", revision: "" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void rpc.developer
      .config()
      .then(setConfig, () => setError(t`Could not load the server configuration.`));
  }, [t]);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (!preview) setPreview(await rpc.developer.preview(config));
      else {
        const native = await ensureCustomizationHost();
        await native.applyConfig(selectedSpaceId(), preview.id);
        onApplied();
        onClose();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : t`Could not complete this action.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{preview ? t`Review changes` : t`Edit config`}</DialogTitle>
        </DialogHeader>
        {preview ? (
          <div className="max-h-96 space-y-4 overflow-auto">
            {preview.changes.length ? (
              preview.changes.map((change) => (
                <div key={change.name} className="space-y-2">
                  <p className="text-sm font-medium">
                    {change.name} ·{" "}
                    {change.action === "add"
                      ? t`Add`
                      : change.action === "remove"
                        ? t`Remove`
                        : t`Change`}
                  </p>
                  {change.action === "change" && change.before === change.after ? (
                    <p className="text-xs text-muted-foreground">{t`Credentials changed`}</p>
                  ) : null}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {change.before ? (
                      <section aria-label={t`Before`}>
                        <pre className="overflow-auto rounded border border-border bg-muted p-2 text-xs">
                          {change.before}
                        </pre>
                      </section>
                    ) : null}
                    {change.after ? (
                      <section aria-label={t`After`}>
                        <pre className="overflow-auto rounded border border-border bg-muted p-2 text-xs">
                          {change.after}
                        </pre>
                      </section>
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">{t`No changes.`}</p>
            )}
          </div>
        ) : (
          <Textarea
            aria-label={t`Server configuration JSON`}
            className="min-h-72 font-mono text-xs"
            value={config.json}
            onChange={(event) => setConfig({ ...config, json: event.target.value })}
            spellCheck={false}
          />
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => (preview ? setPreview(null) : onClose())}
          >
            {preview ? t`Back` : t`Cancel`}
          </Button>
          <Button
            disabled={busy || !config.revision || (preview !== null && !preview.changes.length)}
            onClick={() => void save()}
          >
            {preview ? t`Apply` : t`Review changes`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export default function DeveloperPage() {
  const { t } = useLingui();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState<McpDiagnostics | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [editing, setEditing] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const rows = await rpc.developer.list();
      setServers(rows);
      setSelected((id) => (rows.some((row) => row.id === id) ? id : (rows[0]?.id ?? null)));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let active = true;
    setLogs(null);
    const load = async () => {
      if (!selected) return;
      try {
        const result = await rpc.developer.logs({ serverId: selected });
        if (active) {
          setLogs(result);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      }
    };
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selected]);
  if (!desktopBridge())
    return (
      <p className="text-sm text-muted-foreground">{t`Open the desktop app to manage local servers.`}</p>
    );
  const server = servers.find((row) => row.id === selected);
  return (
    <section aria-label={t`Developer`} className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{t`Local MCP servers`}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t`Add and manage MCP servers that you're working on`}</p>
        </div>
        <Button variant="outline" onClick={() => setEditing(true)}>{t`Edit config`}</Button>
      </div>
      {failed ? <PageError retry={() => void refresh()} /> : null}
      <div className="grid min-h-80 overflow-hidden rounded-lg border border-border sm:grid-cols-[12rem_1fr]">
        <div className="border-b border-border p-2 sm:border-r sm:border-b-0">
          {servers.length ? (
            servers.map((row) => (
              <Button
                key={row.id}
                variant={row.id === selected ? "secondary" : "ghost"}
                className="mb-1 w-full justify-start"
                onClick={() => {
                  setSelected(row.id);
                  setShowLogs(false);
                }}
              >
                <Terminal className="shrink-0" />
                <span className="truncate">{row.name}</span>
              </Button>
            ))
          ) : (
            <EmptyList />
          )}
        </div>
        <div className="min-w-0 space-y-4 p-4">
          {server ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate text-sm font-medium">{server.name}</h3>
                <Badge variant="secondary">
                  {logs?.status === "error" ? (
                    <AlertTriangle className="size-3 text-destructive" />
                  ) : null}
                  {logs?.status === "running"
                    ? t`Running`
                    : logs?.status === "error"
                      ? t`Error`
                      : t`Stopped`}
                </Badge>
              </div>
              {server.managedBy ? (
                <p className="text-xs text-muted-foreground">
                  {server.managedBy === "extension"
                    ? t`This server is managed by an extension`
                    : t`This server is managed by a plugin`}
                </p>
              ) : null}
              {logs?.lastError ? (
                <p className="break-words text-xs text-destructive">{logs.lastError}</p>
              ) : null}
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t`Command`}</dt>
                  <dd className="break-all font-mono text-xs">{server.command}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t`Arguments`}</dt>
                  <dd className="break-all font-mono text-xs">{JSON.stringify(server.args)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t`Environment variables`}</dt>
                  <dd className="break-all font-mono text-xs">
                    {server.envKeys.join(", ") || t`None`}
                  </dd>
                </div>
              </dl>
              <Button variant="outline" size="sm" onClick={() => setShowLogs((value) => !value)}>
                {showLogs ? t`Hide logs` : t`View logs`}
              </Button>
              {showLogs ? (
                <section aria-label={t`Server logs`}>
                  <pre className="max-h-80 overflow-auto rounded bg-muted p-3 text-xs">
                    {logs?.lines.join("\n") || t`No logs yet.`}
                  </pre>
                </section>
              ) : null}
            </>
          ) : (
            <EmptyList />
          )}
        </div>
      </div>
      {editing ? (
        <DeveloperConfigEditor onClose={() => setEditing(false)} onApplied={() => void refresh()} />
      ) : null}
    </section>
  );
}
