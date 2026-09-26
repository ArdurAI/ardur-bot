import type {
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  IntegrationConnection,
  IntegrationDescriptor,
} from "@ardurbot/contracts";
import { Button, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { remoteConnection } from "../../lib/connect-integration";
import { mcpOutcomeSentence } from "../../lib/mcp-sign-in";
import { rpc } from "../../lib/rpc";
import { connectRemoteMcp, matchesCatalogEndpoint } from "./connect-remote-mcp";

type Target = {
  name: string;
  endpoint: string;
  surface?: IntegrationCatalogSurface;
  descriptor?: IntegrationDescriptor;
};

type Waiting = { cancel: () => Promise<void> };

/** A row in one of these states never finished; Connect continues it instead of creating a
 * second row. A connected or needs-sign-in row shows Manage instead (see `existing`). */
const REUSABLE_STATES = new Set([
  "cancelled",
  "discovery-failed",
  "awaiting-consent",
  "needs-client-registration",
]);

export function DirectMcpSearch({
  botId,
  catalog = [],
  connections = [],
  onConnectCatalog,
  onManage,
  onConnected,
  onWaitingChange,
}: {
  botId?: string;
  catalog?: IntegrationDescriptor[];
  connections?: IntegrationConnection[];
  /**
   * Starts or resumes a connection for a built-in app. Null means the page already said why
   * not. `connection` is a cancelled, failed, awaiting-consent or needs-registration row for
   * this app to continue instead of a second one.
   */
  onConnectCatalog?: (
    descriptor: IntegrationDescriptor,
    token: string | undefined,
    hooks: { onWaiting: (waiting: Waiting) => void },
    connection?: IntegrationConnection,
  ) => Promise<IntegrationConnection | null>;
  onManage?: (connection: IntegrationConnection) => void;
  onConnected?: (serverId: string) => void | Promise<void>;
  /** Reports a sign-in wait so a parent that can navigate away treats it as busy. */
  onWaitingChange?: (waiting: boolean) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IntegrationCatalogResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [urlToken, setUrlToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"search" | "connect" | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  // A credential belongs to the one result it was typed for.
  const [credential, setCredential] = useState<{ endpoint: string; value: string } | null>(null);
  const [rejectedEndpoint, setRejectedEndpoint] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const attempt = useRef(0);
  const userCancelled = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    onWaitingChange?.(waiting !== null);
  }, [waiting, onWaitingChange]);
  // Leaving this view stops its polling; the sign-in itself continues.
  useEffect(
    () => () => {
      attempt.current += 1;
      abort.current?.abort();
      onWaitingChange?.(false);
    },
    [],
  );
  const remoteResults = [
    ...new Map(
      results.flatMap((result) =>
        result.surfaces
          .filter((surface) => surface.kind === "mcp" && surface.source?.startsWith("https://"))
          .map((surface) => {
            const descriptor = matchingDescriptor(catalog, surface.source!);
            return [
              surface.source!,
              {
                name: descriptor?.name ?? result.name,
                endpoint: surface.source!,
                surface,
                descriptor,
              },
            ] as const;
          }),
      ),
    ).values(),
  ];
  const typedDescriptor = endpoint.trim()
    ? matchingDescriptor(catalog, endpoint.trim())
    : undefined;

  async function search() {
    setBusy(true);
    setError(null);
    try {
      const response = await rpc.capabilities.catalogSearch({
        query,
        usePublicCatalog: true,
      });
      setResults(response.results);
      setSearched(true);
    } catch {
      setError("search");
    } finally {
      setBusy(false);
    }
  }

  async function connect(target: Target, token: string) {
    const mine = ++attempt.current;
    userCancelled.current = false;
    if (credential && credential.endpoint !== target.endpoint) {
      setCredential(null);
      setRejectedEndpoint(null);
    }
    const auth = target.surface?.auth;
    // A built-in app's own sign-in decides. A listing's auth decides for any other server.
    const needsToken = target.descriptor
      ? target.descriptor.authKind === "token"
      : auth?.type === "bearer" || auth?.type === "header";
    if (needsToken && !token.trim()) {
      setCredential({ endpoint: target.endpoint, value: "" });
      setRejectedEndpoint(null);
      setNotice(null);
      return;
    }
    setBusy(true);
    setError(null);
    setRejectedEndpoint(null);
    setNotice(null);
    setWaiting(null);
    const onWaiting = (wait: Waiting) => {
      if (mine !== attempt.current) return;
      setBusy(false);
      setWaiting(wait);
    };
    const controller = new AbortController();
    abort.current = controller;
    try {
      if (target.descriptor) {
        const reusable = remoteConnection(connections, target.descriptor.id);
        const connection = await onConnectCatalog?.(
          target.descriptor,
          needsToken ? token.trim() : undefined,
          { onWaiting },
          reusable && REUSABLE_STATES.has(reusable.state) ? reusable : undefined,
        );
        if (mine !== attempt.current || !connection) return;
        // Popup-blocked sign-in continues in this tab and finishes there.
        if (connection.state === "awaiting-consent") return;
        setWaiting(null);
        if (connection.state === "connected") {
          setConnected((current) => [...current, target.endpoint]);
          setCredential(null);
          return;
        }
        setNotice(
          connection.state === "needs-client-registration"
            ? t`This service needs client registration before you can connect.`
            : mcpOutcomeSentence(
                connection.state === "cancelled" ? "cancelled" : "sign-in-failed",
                userCancelled.current,
                connection.lastError,
              ),
        );
        return;
      }
      const outcome = await connectRemoteMcp({
        name: target.name,
        endpoint: target.endpoint,
        botId,
        auth: auth?.type === "none" ? "none" : auth?.type === "mixed" ? "mixed" : "oauth",
        credential: token.trim() ? { value: token, headerName: auth?.headerName } : undefined,
        onWaiting,
        signal: controller.signal,
      });
      if (mine !== attempt.current) return;
      setWaiting(null);
      if (outcome.result === "connected") {
        setConnected((current) => [...current, target.endpoint]);
        setCredential(null);
        setUrlToken("");
        await onConnected?.(outcome.serverId);
      } else if (outcome.result === "credential-rejected") {
        setCredential({ endpoint: target.endpoint, value: token });
        setRejectedEndpoint(target.endpoint);
      } else if (outcome.result === "needs-credential" || outcome.result === "oauth-unavailable") {
        setCredential({ endpoint: target.endpoint, value: "" });
      } else {
        setNotice(mcpOutcomeSentence(outcome.result, userCancelled.current, outcome.recorded));
      }
    } catch {
      if (mine === attempt.current) setError("connect");
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  }

  /** "Connected" and Manage for a built-in app that already has a connection, as its card shows. */
  function existing(descriptor: IntegrationDescriptor | undefined) {
    const connection = descriptor ? remoteConnection(connections, descriptor.id) : undefined;
    if (connection?.state !== "connected" && connection?.state !== "needs-sign-in") return null;
    return (
      <>
        <span className="text-sm text-muted-foreground">
          {connection.state === "connected" ? t`Connected` : t`Needs sign-in`}
        </span>
        {onManage ? (
          <Button variant="outline" onClick={() => onManage(connection)}>{t`Manage`}</Button>
        ) : null}
      </>
    );
  }

  const rejected = (
    <p className="text-sm text-destructive" role="alert">
      {t`That token was not accepted. Check it and try again.`}
    </p>
  );
  return (
    <div className="space-y-6" data-testid="find-apps">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Input
          aria-label={t`Search apps`}
          placeholder={t`Search apps`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" disabled={busy || !query.trim()}>
          <Trans>Search integrations.sh</Trans>
        </Button>
      </form>
      {remoteResults.map((result) => (
        <div key={result.endpoint} className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">{result.name}</span>
            {existing(result.descriptor) ?? (
              <Button
                variant="outline"
                disabled={
                  (busy && !waiting) ||
                  connected.includes(result.endpoint) ||
                  (result.descriptor?.authKind === "token" &&
                    credential?.endpoint === result.endpoint &&
                    !credential.value.trim())
                }
                onClick={() =>
                  void connect(
                    result,
                    credential?.endpoint === result.endpoint ? credential.value : "",
                  )
                }
              >
                {connected.includes(result.endpoint) ? t`Connected` : t`Connect`}
              </Button>
            )}
          </div>
          {credential?.endpoint === result.endpoint ? (
            <Input
              type="password"
              autoComplete="off"
              aria-label={t`Credential`}
              placeholder={result.surface.auth?.headerName ?? undefined}
              value={credential.value}
              onChange={(event) =>
                setCredential({ endpoint: result.endpoint, value: event.target.value })
              }
            />
          ) : null}
          {rejectedEndpoint === result.endpoint ? rejected : null}
        </div>
      ))}
      {searched && !remoteResults.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No remote MCP servers found</Trans>
        </p>
      ) : null}
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">
          <Trans>Add server URL</Trans>
        </summary>
        <div className="mt-3 space-y-3">
          <Input
            aria-label={t`Server URL`}
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://example.com/mcp"
          />
          {typedDescriptor ? (
            <p className="text-sm text-muted-foreground">{typedDescriptor.name}</p>
          ) : null}
          {typedDescriptor?.authKind === "oauth" ? null : (
            <div className="space-y-1">
              <label htmlFor="direct-mcp-url-token" className="text-sm text-muted-foreground">
                {typedDescriptor?.authKind === "token"
                  ? t`Access token`
                  : t`Access token (optional)`}
              </label>
              <Input
                id="direct-mcp-url-token"
                type="password"
                autoComplete="off"
                value={urlToken}
                onChange={(event) => setUrlToken(event.target.value)}
              />
            </div>
          )}
          {rejectedEndpoint === endpoint.trim() ? rejected : null}
          {existing(typedDescriptor) ?? (
            <Button
              disabled={
                (busy && !waiting) ||
                !endpoint.trim() ||
                (typedDescriptor?.authKind === "token" && !urlToken.trim())
              }
              onClick={() =>
                void connect(
                  {
                    name: typedDescriptor?.name ?? "MCP server",
                    endpoint: endpoint.trim(),
                    descriptor: typedDescriptor,
                  },
                  urlToken,
                )
              }
            >
              <Trans>Connect</Trans>
            </Button>
          )}
        </div>
      </details>
      {waiting ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{t`Waiting for sign-in in the other window.`}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              userCancelled.current = true;
              void waiting.cancel();
            }}
          >{t`Cancel sign-in`}</Button>
        </div>
      ) : null}
      {notice ? (
        <p className="text-sm text-destructive" role="alert">
          {notice}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">
            {error === "search"
              ? t`Could not search integrations.`
              : t`Could not connect or load integrations.`}
          </p>
          {error === "search" ? (
            <Button variant="outline" onClick={() => void search()}>{t`Retry`}</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function matchingDescriptor(
  catalog: IntegrationDescriptor[],
  endpoint: string,
): IntegrationDescriptor | undefined {
  return catalog.find(
    (descriptor) => !!descriptor.endpoint && matchesCatalogEndpoint(endpoint, descriptor.endpoint),
  );
}
