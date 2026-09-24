import type { IntegrationConnection, IntegrationDescriptor, McpServer } from "@ardurbot/contracts";
import { Button, Input } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { connectIntegration } from "../../../lib/connect-integration";
import { refreshIntegrationCatalog } from "../../../lib/integration-catalog-query";
import { MCP_OAUTH_CHANNEL } from "../../../lib/mcp-connect";
import { rpc } from "../../../lib/rpc";
import type { CatalogTab } from "../../../pages/customize/CustomizeControls";
import { CustomizeToolbar } from "../../../pages/customize/CustomizeControls";
import { connectorRows } from "../../../pages/customize/connector-rows";
import { IntegrationTable } from "../../../pages/customize/IntegrationTable";
import { IntegrationManage } from "./IntegrationManage";

export function IntegrationCatalog({
  reconnectId,
  onBusyChange,
}: {
  reconnectId?: string;
  onBusyChange?(busy: boolean): void;
}) {
  const { t } = useLingui();
  const consentPopup = useRef<Window | null>(null);
  const focusedReconnect = useRef<string | null>(null);
  const [tab, setTab] = useState<CatalogTab>("catalog");
  const [query, setQuery] = useState("");
  const [servers, setServers] = useState<McpServer[]>([]);
  const [catalog, setCatalog] = useState<IntegrationDescriptor[]>([]);
  const [connections, setConnections] = useState<IntegrationConnection[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [host, setHost] = useState("");
  const [customHost, setCustomHost] = useState(false);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState("");
  useEffect(() => {
    onBusyChange?.(busy !== null);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const refresh = async () => {
    const [result, servers] = await Promise.all([
      refreshIntegrationCatalog(),
      rpc.mcp.servers.list(),
    ]);
    setServers(servers);
    if (reconnectId && focusedReconnect.current !== reconnectId) {
      const connection = result.connections.find((row) => row.id === reconnectId);
      if (connection) {
        focusedReconnect.current = reconnectId;
        setTab("yours");
        setTokenFor(connection.catalogId);
      }
    }
    setCatalog(result.catalog);
    setConnections(result.connections);
    setError(false);
  };
  useEffect(() => {
    void refresh().catch(() => setError(true));
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    channel.onmessage = () => {
      void refresh().catch(() => setError(true));
    };
    return () => channel.close();
  }, []);

  async function connect(
    descriptor: IntegrationDescriptor,
    connection?: IntegrationConnection,
    authKind = descriptor.authKind,
  ) {
    setBusy(descriptor.id);
    setError(false);
    try {
      const connectionResult = await connectIntegration(descriptor, connection, {
        token,
        authKind,
        host: descriptor.id === "gitlab" && customHost ? host : undefined,
        onPopup: (popup) => {
          consentPopup.current = popup;
        },
        onStarted: (started) => {
          setConnections((current) => [
            started,
            ...current.filter((entry) => entry.id !== started.id),
          ]);
        },
      });
      await refresh();
      setSelected(connectionResult.id);
    } catch {
      setError(true);
    } finally {
      setToken("");
      setTokenFor(null);
      consentPopup.current = null;
      setBusy(null);
    }
  }
  async function cancel(connection: IntegrationConnection) {
    setBusy(connection.catalogId);
    try {
      await rpc.integrations.cancel({ connectionId: connection.id });
      consentPopup.current?.close();
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }
  const active = connections.find(
    (connection) => connection.id === selected && connection.state === "connected",
  );
  const descriptor = catalog.find((entry) => entry.id === active?.catalogId);
  if (active && descriptor)
    return (
      <IntegrationManage
        key={active.id}
        descriptor={descriptor}
        connection={active}
        onBack={() => setSelected(null)}
        onChanged={refresh}
      />
    );

  function sentence(descriptor: IntegrationDescriptor, connection?: IntegrationConnection) {
    if (
      descriptor.id === "github" &&
      descriptor.authKind === "token" &&
      (!connection || ["not-connected", "needs-client-registration"].includes(connection.state))
    )
      return t`Sign-in needs a pre-registered app; use a fine-grained token instead.`;
    switch (connection?.state) {
      case "awaiting-consent":
        return t`Finish signing in in your browser.`;
      case "connected":
        return connection.needsReview
          ? t`Review tools before your bots can use this account.`
          : t`Your account is connected.`;
      case "discovery-failed":
        return t`Could not load this account’s tools.`;
      case "cancelled":
        return t`The connection was cancelled.`;
      case "needs-client-registration":
        return t`This service needs client registration before you can connect.`;
      default:
        return t`Connect your account.`;
    }
  }
  const rows = connectorRows({ catalog, connections, servers, catalogTab: true }).filter(
    (row) =>
      (tab === "catalog" || !row.id.startsWith("catalog:")) &&
      row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="space-y-4" data-testid="integration-catalog">
      <CustomizeToolbar
        tab={tab}
        onTab={setTab}
        query={query}
        onQuery={setQuery}
        searchLabel={t`Search integrations`}
      />
      {error ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t`Could not connect or load integrations.`}</p>
          <Button
            variant="outline"
            onClick={() => void refresh().catch(() => setError(true))}
          >{t`Try again`}</Button>
        </div>
      ) : null}
      <IntegrationTable
        rows={rows}
        busy={busy}
        onConnect={(row) => {
          const descriptor = catalog.find((item) => item.id === row.catalogId);
          const connection = connections.find((item) => item.id === row.id);
          if (!descriptor) return;
          if (descriptor.authKind === "token") setTokenFor(descriptor.id);
          else void connect(descriptor, connection);
        }}
        renderActions={(row) => {
          const descriptor = catalog.find((item) => item.id === row.catalogId)!;
          const connection = connections.find((item) => item.id === row.id);
          return (
            <div className="mt-2 space-y-3">
              {descriptor.available ? (
                <p className="text-sm text-muted-foreground">{sentence(descriptor, connection)}</p>
              ) : null}
              {!descriptor.available ? (
                <span className="text-xs text-muted-foreground">{t`Coming soon`}</span>
              ) : descriptor.authKind === "token" &&
                (connection?.state !== "connected" || row.status === "reconnect") &&
                connection?.state !== "awaiting-consent" ? (
                <div className="space-y-3">
                  {tokenFor === descriptor.id ? (
                    <form
                      className="space-y-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void connect(descriptor, connection, "token");
                      }}
                    >
                      <Input
                        type="password"
                        aria-label={t`Fine-grained token`}
                        autoComplete="off"
                        spellCheck={false}
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                      />
                      <p className="text-sm text-muted-foreground">{t`Grant only the repositories and permissions this bot needs.`}</p>
                      <a
                        className="text-sm underline"
                        href={descriptor.tokenUrl}
                        target="_blank"
                        rel="noreferrer"
                      >{t`Create a token`}</a>
                      <div className="flex gap-2">
                        <Button
                          type="submit"
                          disabled={busy !== null || !token.trim()}
                        >{t`Connect`}</Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => {
                            setToken("");
                            setTokenFor(null);
                          }}
                        >{t`Cancel`}</Button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={busy !== null}
                        onClick={() => {
                          setToken("");
                          setTokenFor(descriptor.id);
                        }}
                      >
                        {row.status === "reconnect" ? t`Reconnect` : t`Use a token`}
                      </Button>
                      <Button
                        variant="outline"
                        render={<a href={descriptor.docsUrl} target="_blank" rel="noreferrer" />}
                      >{t`Open documentation`}</Button>
                      {descriptor.oauthAvailable ? (
                        <Button
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => void connect(descriptor, connection, "oauth")}
                        >{t`Sign in with GitHub`}</Button>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : connection?.state === "needs-client-registration" ? (
                <Button
                  variant="outline"
                  render={<a href={descriptor.docsUrl} target="_blank" rel="noreferrer" />}
                >{t`Open documentation`}</Button>
              ) : row.status === "reconnect" ? (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void connect(descriptor, connection)}
                >{t`Reconnect`}</Button>
              ) : connection?.state === "connected" ? (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => setSelected(connection.id)}
                >
                  {connection.needsReview ? t`Review tools` : t`Manage`}
                </Button>
              ) : connection?.state === "awaiting-consent" ? (
                <Button
                  variant="outline"
                  disabled={busy !== null && busy !== descriptor.id}
                  onClick={() => void cancel(connection)}
                >{t`Cancel`}</Button>
              ) : connection?.state === "discovery-failed" ? (
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void connect(descriptor, connection)}
                >{t`Try again`}</Button>
              ) : (
                <Button
                  disabled={busy !== null || (descriptor.id === "gitlab" && customHost && !host)}
                  onClick={() => void connect(descriptor, connection)}
                >{t`Connect`}</Button>
              )}
              {descriptor.id === "gitlab" && !connection ? (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">{t`Advanced`}</summary>
                  <div className="mt-3 space-y-2">
                    <Button
                      size="sm"
                      variant="outline"
                      aria-pressed={customHost}
                      onClick={() => setCustomHost(!customHost)}
                    >{t`Use your GitLab host`}</Button>
                    {customHost ? (
                      <Input
                        aria-label={t`GitLab host`}
                        placeholder="https://gitlab.example.com"
                        value={host}
                        onChange={(event) => setHost(event.target.value)}
                      />
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
          );
        }}
      />
    </div>
  );
}
