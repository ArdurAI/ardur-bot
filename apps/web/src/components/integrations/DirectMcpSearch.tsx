import type {
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  IntegrationDescriptor,
} from "@ardurbot/contracts";
import { Button, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import type { McpOauthWait } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import { connectRemoteMcp, matchesCatalogEndpoint } from "./connect-remote-mcp";

type Target = {
  name: string;
  endpoint: string;
  surface?: IntegrationCatalogSurface;
  descriptor?: IntegrationDescriptor;
};

export function DirectMcpSearch({
  botId,
  catalog = [],
  onConnectCatalog,
  onConnected,
}: {
  botId?: string;
  catalog?: IntegrationDescriptor[];
  onConnectCatalog?: (descriptor: IntegrationDescriptor, token?: string) => Promise<boolean>;
  onConnected?: (serverId: string) => void | Promise<void>;
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
  const [notice, setNotice] = useState<
    "declined" | "unfinished" | "replaced" | "waiting" | "cancelled" | null
  >(null);
  const [waiting, setWaiting] = useState<McpOauthWait | null>(null);
  const attempt = useRef(0);
  const userCancelled = useRef(false);
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
    const auth = target.surface?.auth;
    if (credential && credential.endpoint !== target.endpoint) {
      setCredential(null);
      setRejectedEndpoint(null);
    }
    if (
      !target.descriptor &&
      (auth?.type === "bearer" || auth?.type === "header") &&
      !token.trim()
    ) {
      setCredential({ endpoint: target.endpoint, value: "" });
      setRejectedEndpoint(null);
      return;
    }
    const catalogToken = target.descriptor?.authKind === "token";
    const catalogMixed = Boolean(target.descriptor) && auth?.type === "mixed";
    if (
      (catalogToken || catalogMixed) &&
      !token.trim() &&
      credential?.endpoint !== target.endpoint
    ) {
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
    try {
      if (target.descriptor) {
        const typedToken = target.descriptor.authKind === "oauth" ? "" : token.trim();
        if (await onConnectCatalog?.(target.descriptor, typedToken || undefined))
          setConnected((current) => [...current, target.endpoint]);
        return;
      }
      const outcome = await connectRemoteMcp({
        name: target.name,
        endpoint: target.endpoint,
        botId,
        auth: auth?.type === "none" ? "none" : auth?.type === "mixed" ? "mixed" : "oauth",
        credential: token.trim() ? { value: token, headerName: auth?.headerName } : undefined,
        onWaiting: (wait) => {
          if (mine !== attempt.current) return;
          setBusy(false);
          setWaiting(wait);
          setNotice("waiting");
        },
      });
      if (mine !== attempt.current) return;
      setWaiting(null);
      if (outcome === "credential-rejected") {
        setCredential({ endpoint: target.endpoint, value: token });
        setRejectedEndpoint(target.endpoint);
        return;
      }
      if (outcome === "needs-credential") {
        setCredential({ endpoint: target.endpoint, value: "" });
        return;
      }
      if (outcome === "cancelled") {
        setNotice(userCancelled.current ? "cancelled" : "declined");
        return;
      }
      if (outcome === "needs-sign-in") {
        setNotice("unfinished");
        return;
      }
      if (outcome === "replaced") {
        setNotice("replaced");
        return;
      }
      if (typeof outcome !== "object") {
        if (outcome === "sign-in-failed") setError("connect");
        return;
      }
      setConnected((current) => [...current, target.endpoint]);
      setCredential(null);
      setUrlToken("");
      await onConnected?.(outcome.serverId);
    } catch {
      if (mine === attempt.current) setError("connect");
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
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
          {rejectedEndpoint === result.endpoint ? (
            <p className="text-sm text-destructive" role="alert">
              {t`That token was not accepted. Check it and try again.`}
            </p>
          ) : null}
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
            <Input
              type="password"
              autoComplete="off"
              aria-label={t`Access token (optional)`}
              value={urlToken}
              onChange={(event) => setUrlToken(event.target.value)}
            />
          )}
          {rejectedEndpoint === endpoint.trim() ? (
            <p className="text-sm text-destructive" role="alert">
              {t`That token was not accepted. Check it and try again.`}
            </p>
          ) : null}
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
        </div>
      </details>
      {notice === "waiting" && waiting ? (
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
      {notice === "cancelled" ? (
        <p className="text-sm text-muted-foreground">{t`Sign-in was cancelled.`}</p>
      ) : null}
      {notice === "declined" ? (
        <p className="text-sm text-muted-foreground">
          {t`Sign-in was declined. Reconnect to try again.`}
        </p>
      ) : null}
      {notice === "unfinished" ? (
        <p className="text-sm text-muted-foreground">{t`Sign-in did not finish. Try again.`}</p>
      ) : null}
      {notice === "replaced" ? (
        <p className="text-sm text-muted-foreground">
          {t`This sign-in window was replaced by a newer one. Finish signing in there, or start again.`}
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
