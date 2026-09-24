import type { IntegrationConnection, IntegrationDescriptor, McpServer } from "@ardurbot/contracts";
import { deriveMcpSlug } from "@ardurbot/core";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { Check, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { IntegrationManage } from "../../components/integrations/catalog/IntegrationManage";
import { connectMcpOauth, MCP_OAUTH_CHANNEL, waitForMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import type { CatalogTab } from "./CustomizeControls";
import { CustomizeToolbar, EmptyList, PageError } from "./CustomizeControls";
import type { ConnectorRow } from "./connector-rows";
import { connectorRows } from "./connector-rows";

export function ConnectorsTable({
  rows,
  busy,
  onConnect,
  onManage,
}: {
  rows: ConnectorRow[];
  busy?: string | null;
  onConnect(row: ConnectorRow): void;
  onManage?(row: ConnectorRow): void;
}) {
  const { t } = useLingui();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <th className="py-3 font-normal">{t`Connector`}</th>
            <th className="py-3 font-normal">{t`Type`}</th>
            <th className="py-3 font-normal">{t`Status`}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="py-4 pr-3">
                {onManage && row.status === "connected" && row.catalogId ? (
                  <Button variant="link" className="h-auto p-0" onClick={() => onManage(row)}>
                    {row.name}
                  </Button>
                ) : (
                  row.name
                )}
              </td>
              <td className="py-4 pr-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>{row.type === "web" ? t`Web` : t`Desktop`}</span>
                  {row.badges.map((badge) => (
                    <Badge key={badge} variant="secondary">
                      {badge === "included"
                        ? t`Included`
                        : badge === "local-dev"
                          ? t`Local dev`
                          : t`Custom`}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="py-4">
                <div className="flex items-center gap-2">
                  {row.status === "connected" ? (
                    <>
                      <Check className="size-4 text-success" aria-hidden />
                      <span>{t`Connected`}</span>
                    </>
                  ) : row.status === "reconnect" ? (
                    <>
                      <TriangleAlert
                        className="size-4 text-warning"
                        aria-label={t`Needs reconnection`}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === row.id}
                        onClick={() => onConnect(row)}
                      >{t`Reconnect`}</Button>
                    </>
                  ) : (
                    <>
                      <span className="text-muted-foreground">{t`Disconnected`}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!row.available || busy === row.id}
                        onClick={() => onConnect(row)}
                      >{t`Connect`}</Button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? <EmptyList /> : null}
    </div>
  );
}

export default function ConnectorsPage() {
  const { t } = useLingui();
  const [tab, setTab] = useState<CatalogTab>("yours");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{
    catalog: IntegrationDescriptor[];
    connections: IntegrationConnection[];
    servers: McpServer[];
  }>({ catalog: [], connections: [], servers: [] });
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [managed, setManaged] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tokenFor, setTokenFor] = useState<ConnectorRow | null>(null);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [gitlabHost, setGitlabHost] = useState("");
  const refresh = useCallback(async () => {
    const [integrations, servers] = await Promise.all([
      rpc.integrations.list(),
      rpc.mcp.servers.list(),
    ]);
    setData({ ...integrations, servers });
    setFailed(false);
  }, []);
  useEffect(() => {
    void refresh().catch(() => setFailed(true));
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    channel.onmessage = () => {
      void refresh().catch(() => setFailed(true));
    };
    return () => channel.close();
  }, [refresh]);
  async function connect(row: ConnectorRow, credential?: string) {
    const descriptor = data.catalog.find((entry) => entry.id === row.catalogId);
    const server = data.servers.find((entry) => entry.id === row.id);
    if (
      (descriptor?.authKind === "token" ||
        (!descriptor &&
          server?.transport !== "stdio" &&
          !server?.managedBy &&
          server?.hasSecret &&
          server.oauthStatus === "none")) &&
      credential === undefined
    ) {
      setTokenFor(row);
      return;
    }
    setBusy(row.id);
    setFailed(false);
    const popup =
      descriptor?.authKind === "oauth"
        ? window.open("about:blank", MCP_OAUTH_CHANNEL, "popup,width=560,height=720")
        : null;
    try {
      if (descriptor) {
        const result = await rpc.integrations.connect({
          catalogId: descriptor.id,
          connectionId: row.id.startsWith("catalog:") ? undefined : row.id,
          ...(descriptor.authKind === "token" ? { authKind: "token", token: credential } : {}),
          ...(descriptor.id === "gitlab" && gitlabHost ? { host: gitlabHost } : {}),
        });
        if (result.authorizationUrl) {
          const state = await waitForMcpOauth(result.authorizationUrl, popup, result.sessionId);
          if (state === "cancelled")
            await rpc.integrations.cancel({ connectionId: result.connection.id });
        } else popup?.close();
      } else if (credential !== undefined) {
        await rpc.mcp.servers.update({ id: row.id, secret: credential });
        await rpc.integrations.discover({ connectionId: row.id });
      } else if (server?.transport === "stdio" || server?.managedBy) {
        await rpc.integrations.discover({ connectionId: row.id });
      } else await connectMcpOauth(row.id);
      setTokenFor(null);
      await refresh();
    } catch {
      popup?.close();
      setFailed(true);
    } finally {
      setToken("");
      setBusy(null);
    }
  }
  async function addCustom() {
    setBusy("add");
    setFailed(false);
    try {
      const server = await rpc.mcp.servers.create({
        name,
        slug: deriveMcpSlug(name),
        transport: "streamable_http",
        endpoint: url,
        headers: {},
        secret: token || undefined,
        enabled: true,
      });
      if (token) await rpc.integrations.discover({ connectionId: server.id });
      else await connectMcpOauth(server.id);
      setAdding(false);
      setName("");
      setUrl("");
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setToken("");
      setBusy(null);
    }
  }
  const connection = data.connections.find((entry) => entry.id === managed);
  const descriptor = data.catalog.find((entry) => entry.id === connection?.catalogId);
  if (connection && descriptor)
    return (
      <IntegrationManage
        descriptor={descriptor}
        connection={connection}
        onBack={() => setManaged(null)}
        onChanged={refresh}
      />
    );
  const rows = connectorRows({ ...data, catalogTab: tab === "catalog" }).filter((row) =>
    row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="space-y-5" data-testid="customize-connectors">
      <CustomizeToolbar
        tab={tab}
        onTab={setTab}
        query={query}
        onQuery={setQuery}
        searchLabel={t`Search connectors`}
        add={[{ label: t`Custom MCP server`, action: () => setAdding(true) }]}
      />
      {failed ? <PageError retry={() => void refresh().catch(() => setFailed(true))} /> : null}
      <ConnectorsTable
        rows={rows}
        busy={busy}
        onConnect={(row) => void connect(row)}
        onManage={(row) => setManaged(row.id)}
      />
      <Dialog
        open={adding || tokenFor !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setAdding(false);
            setTokenFor(null);
            setToken("");
          }
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>
              {adding ? t`Add connector` : t`Connect ${tokenFor?.name ?? ""}`}
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (adding) void addCustom();
              else if (tokenFor) void connect(tokenFor, token);
            }}
          >
            {adding ? (
              <>
                <Field>
                  <FieldLabel htmlFor="connector-name">{t`Name`}</FieldLabel>
                  <Input
                    id="connector-name"
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="connector-url">{t`Server URL`}</FieldLabel>
                  <Input
                    id="connector-url"
                    type="url"
                    required
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </Field>
              </>
            ) : null}
            {tokenFor?.catalogId === "gitlab" ? (
              <Field>
                <FieldLabel htmlFor="connector-host">{t`Host`}</FieldLabel>
                <Input
                  id="connector-host"
                  type="url"
                  value={gitlabHost}
                  onChange={(event) => setGitlabHost(event.target.value)}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="connector-token">{t`Token`}</FieldLabel>
              <Input
                id="connector-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required={!adding}
              />
            </Field>
            {failed ? (
              <p
                role="alert"
                className="text-sm text-destructive"
              >{t`Could not connect. Check the details and try again.`}</p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={busy !== null}>
                {adding ? t`Add` : t`Connect`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
