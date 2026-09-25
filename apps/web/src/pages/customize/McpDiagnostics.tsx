import type { McpDiagnostics as Diagnostics, McpServer } from "@ardurbot/contracts";
import { Badge, Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export function McpDiagnostics({ server }: { server: McpServer }) {
  const { t } = useLingui();
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await rpc.developer.logs({ serverId: server.id });
        if (active) {
          setDiagnostics(value);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      }
    };
    void load();
    const timer = expanded ? setInterval(() => void load(), 5000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [server.id, server.revision, expanded, retry]);
  return (
    <div className="mt-3 space-y-2">
      <Badge variant="secondary">
        {diagnostics?.status === "error" ? (
          <AlertTriangle className="size-3 text-destructive" />
        ) : null}
        {diagnostics?.status === "running"
          ? t`Running`
          : diagnostics?.status === "error"
            ? t`Error`
            : t`Stopped`}
      </Badge>
      {diagnostics?.lastError ? (
        <p className="break-words text-xs text-destructive">{diagnostics.lastError}</p>
      ) : null}
      {failed ? (
        <div role="alert" className="space-y-2">
          <p className="text-xs text-destructive">{t`Could not load server diagnostics.`}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >{t`Try again`}</Button>
        </div>
      ) : null}
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm">{t`Server details`}</summary>
        <dl className="my-3 space-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground">{t`Command`}</dt>
            <dd className="break-all font-mono">{server.command}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t`Arguments`}</dt>
            <dd className="break-all font-mono">{JSON.stringify(server.args)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t`Environment variables`}</dt>
            <dd className="break-all font-mono">{server.envKeys.join(", ") || t`None`}</dd>
          </div>
        </dl>
        <Button variant="outline" size="sm" onClick={() => setShowLogs(!showLogs)}>
          {showLogs ? t`Hide logs` : t`View logs`}
        </Button>
        {showLogs ? (
          <section aria-label={t`Server logs`}>
            <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted p-3 text-xs">
              {diagnostics?.lines.join("\n") || t`No logs yet.`}
            </pre>
          </section>
        ) : null}
      </details>
    </div>
  );
}
