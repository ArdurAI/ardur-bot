import type {
  IntegrationCatalogList,
  IntegrationConnection,
  IntegrationDescriptor,
} from "@ardurbot/contracts";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { connectIntegration } from "../../../lib/connect-integration";
import { refreshIntegrationCatalog } from "../../../lib/integration-catalog-query";
import { MCP_OAUTH_CHANNEL } from "../../../lib/mcp-connect";
import { rpc } from "../../../lib/rpc";
import { IntegrationDetails } from "../manage/IntegrationDetails";

export function IntegrationCards({ reconnectId }: { reconnectId?: string }) {
  const { t } = useLingui();
  const [data, setData] = useState<IntegrationCatalogList>({ catalog: [], connections: [] });
  const [selected, setSelected] = useState<string | null>(reconnectId ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const [clients, setClients] = useState<
    Record<string, { clientId: string; clientSecret?: string }>
  >({});
  const popup = useRef<Window | null>(null);
  const refresh = async () => {
    setData(await refreshIntegrationCatalog());
    setError(false);
  };
  useEffect(() => {
    let active = true;
    const load = () => {
      void refreshIntegrationCatalog()
        .then((value) => {
          if (active) setData(value);
        })
        .catch(() => {
          if (active) setError(true);
        });
    };
    load();
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    channel.onmessage = load;
    const timer = window.setInterval(load, 5000);
    return () => {
      active = false;
      channel.close();
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (reconnectId) setSelected(reconnectId);
  }, [reconnectId]);
  async function connect(
    descriptor: IntegrationDescriptor,
    connection?: IntegrationConnection,
    authKind: "host" | "oauth" | "token" = descriptor.authKind,
  ) {
    setBusy(descriptor.id);
    setError(false);
    try {
      const current = await connectIntegration(descriptor, connection, {
        authKind,
        token,
        host: hosts[descriptor.id] || undefined,
        ...(authKind === "oauth" && clients[descriptor.id]?.clientId
          ? { oauthClient: clients[descriptor.id] }
          : {}),
        onPopup: (value) => {
          popup.current = value;
        },
        onStarted: (value) =>
          setData((current) => ({
            ...current,
            connections: [value, ...current.connections.filter((row) => row.id !== value.id)],
          })),
      });
      await refresh();
      if (current.state === "connected") setSelected(current.id);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
      setToken("");
      setTokenFor(null);
      setClients((current) => ({ ...current, [descriptor.id]: { clientId: "" } }));
    }
  }
  async function cancel(connection: IntegrationConnection) {
    try {
      await rpc.integrations.cancel({ connectionId: connection.id });
      popup.current?.close();
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }
  const active = data.connections.find(
    (row) =>
      row.id === selected &&
      row.state !== "awaiting-consent" &&
      row.state !== "not-connected" &&
      row.state !== "cancelled",
  );
  const descriptor = data.catalog.find((entry) => entry.id === active?.catalogId);
  if (active && descriptor)
    return (
      <IntegrationDetails
        descriptor={descriptor}
        connection={active}
        onBack={() => setSelected(null)}
        onChanged={refresh}
        onReconnect={() => {
          if (active.transport === "host-cli") void connect(descriptor, active, "host");
          else if (descriptor.authKind === "token") {
            setSelected(null);
            setTokenFor(descriptor.id);
          } else void connect(descriptor, active);
        }}
      />
    );

  function status(connection?: IntegrationConnection) {
    if (connection?.lastError === "Sign-in timed out.") return t`Sign-in timed out.`;
    switch (connection?.state) {
      case "connected":
        return t`Connected`;
      case "awaiting-consent":
        return t`Finish signing in in your browser.`;
      case "needs-sign-in":
        return t`Needs sign-in`;
      case "discovery-failed":
        return t`Could not load this account’s tools.`;
      case "cancelled":
        return t`The connection was cancelled.`;
      case "needs-client-registration":
        return t`This service needs client registration before you can connect.`;
      default:
        return null;
    }
  }
  return (
    <div className="space-y-4" data-testid="integration-catalog">
      {error ? (
        <div role="alert">
          <p className="text-sm text-destructive">{t`Could not connect or load integrations.`}</p>
          <Button
            variant="outline"
            onClick={() => void refresh().catch(() => setError(true))}
          >{t`Try again`}</Button>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {data.catalog.map((entry) => {
          const remote = data.connections.find(
            (row) => row.catalogId === entry.id && row.transport !== "host-cli",
          );
          const local = data.connections.find(
            (row) => row.catalogId === entry.id && row.transport === "host-cli",
          );
          const hostIdentity = data.hostSignIns?.find((row) => row.id === entry.id);
          const identity = hostIdentity?.identity;
          const manage = (row: IntegrationConnection) => (
            <Button variant="outline" onClick={() => setSelected(row.id)}>{t`Manage`}</Button>
          );
          return (
            <Card key={entry.id} data-testid={`integration-${entry.id}`}>
              <CardHeader>
                <CardTitle>{entry.name}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {entry.hostCli ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {identity && hostIdentity?.state === "signed-in"
                        ? t`Signed in on this computer as ${identity}`
                        : hostIdentity?.state === "not-found"
                          ? t`Not found on this computer`
                          : hostIdentity?.state === "needs-sign-in"
                            ? t`Needs sign-in on this computer`
                            : hostIdentity?.state === "unavailable"
                              ? t`Could not check this computer.`
                              : t`Open the desktop app to check this computer.`}
                    </p>
                    {local?.state === "connected" ? (
                      manage(local)
                    ) : hostIdentity?.state === "signed-in" ? (
                      <Button
                        disabled={busy !== null}
                        onClick={() => void connect(entry, local, "host")}
                      >{t`Use for bots on this computer`}</Button>
                    ) : (
                      <Button
                        variant="outline"
                        render={
                          <a href={entry.hostCli.installUrl} target="_blank" rel="noreferrer" />
                        }
                      >{t`Open documentation`}</Button>
                    )}
                  </div>
                ) : null}
                {entry.endpoint || remote || entry.id === "azure" ? (
                  <div className="space-y-2">
                    {status(remote) ? (
                      <p className="text-sm text-muted-foreground">{status(remote)}</p>
                    ) : null}
                    {remote?.state === "awaiting-consent" ? (
                      <Button
                        variant="outline"
                        onClick={() => void cancel(remote)}
                      >{t`Cancel`}</Button>
                    ) : (remote?.state === "connected" || remote?.state === "needs-sign-in") &&
                      tokenFor !== entry.id ? (
                      manage(remote)
                    ) : (
                      <>
                        {entry.authKind === "oauth" && entry.endpoint ? (
                          <Button
                            disabled={busy !== null}
                            onClick={() => void connect(entry, remote)}
                          >
                            {entry.hostCli ? t`Connect remote account` : t`Connect`}
                          </Button>
                        ) : null}
                        {entry.oauthAvailable ? (
                          <Button
                            variant="outline"
                            disabled={busy !== null}
                            onClick={() => void connect(entry, remote, "oauth")}
                          >{t`Connect remote account`}</Button>
                        ) : null}
                        {entry.authKind === "token" ? (
                          tokenFor === entry.id ? (
                            <form
                              className="space-y-2"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void connect(entry, remote, "token");
                              }}
                            >
                              <Input
                                type="password"
                                autoComplete="off"
                                aria-label={t`Fine-grained token`}
                                value={token}
                                onChange={(event) => setToken(event.target.value)}
                              />
                              <Button
                                type="submit"
                                disabled={busy !== null || !token.trim()}
                              >{t`Connect`}</Button>
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() => {
                                  setToken("");
                                  setTokenFor(null);
                                }}
                              >{t`Cancel`}</Button>
                            </form>
                          ) : (
                            <Button
                              variant="outline"
                              onClick={() => setTokenFor(entry.id)}
                            >{t`Use a token`}</Button>
                          )
                        ) : null}
                      </>
                    )}
                    {["github", "gitlab", "azure"].includes(entry.id) ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">{t`Advanced`}</summary>
                        {entry.id !== "github" ? (
                          <Input
                            aria-label={entry.id === "gitlab" ? t`GitLab host` : t`Remote MCP URL`}
                            placeholder={entry.id === "gitlab" ? t`GitLab host` : t`Remote MCP URL`}
                            value={hosts[entry.id] ?? ""}
                            onChange={(event) =>
                              setHosts((current) => ({
                                ...current,
                                [entry.id]: event.target.value,
                              }))
                            }
                          />
                        ) : null}
                        {entry.id !== "gitlab" ? (
                          <>
                            <Input
                              aria-label={t`Client ID`}
                              placeholder={t`Client ID`}
                              value={clients[entry.id]?.clientId ?? ""}
                              onChange={(event) =>
                                setClients((current) => ({
                                  ...current,
                                  [entry.id]: {
                                    ...current[entry.id],
                                    clientId: event.target.value,
                                  },
                                }))
                              }
                            />
                            <Input
                              aria-label={t`Client secret`}
                              placeholder={t`Client secret`}
                              type="password"
                              autoComplete="off"
                              value={clients[entry.id]?.clientSecret ?? ""}
                              onChange={(event) =>
                                setClients((current) => ({
                                  ...current,
                                  [entry.id]: {
                                    clientId: current[entry.id]?.clientId ?? "",
                                    clientSecret: event.target.value || undefined,
                                  },
                                }))
                              }
                            />
                          </>
                        ) : null}
                        {entry.id === "azure" ||
                        (entry.id === "github" && clients[entry.id]?.clientId) ? (
                          <Button
                            disabled={busy !== null || (entry.id === "azure" && !hosts[entry.id])}
                            onClick={() => void connect(entry, remote, "oauth")}
                          >{t`Connect remote account`}</Button>
                        ) : null}
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {entry.remoteDocsUrl ? (
                  <a
                    className="text-sm underline"
                    href={entry.remoteDocsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >{t`Remote setup`}</a>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
