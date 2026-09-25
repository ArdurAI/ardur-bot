import type {
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  IntegrationDescriptor,
} from "@ardurbot/contracts";
import { Button, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { connectRemoteMcp, normalizedEndpoint } from "./connect-remote-mcp";

export function DirectMcpSearch({
  botId,
  catalog = [],
  secret = "",
  onConnectCatalog,
  onConnected,
}: {
  botId?: string;
  catalog?: IntegrationDescriptor[];
  secret?: string;
  onConnectCatalog?: (descriptor: IntegrationDescriptor) => Promise<boolean>;
  onConnected?: (serverId: string) => void | Promise<void>;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IntegrationCatalogResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"search" | "connect" | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [credentialFor, setCredentialFor] = useState<string | null>(null);
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

  async function connect(
    name: string,
    url: string,
    surface?: IntegrationCatalogSurface,
    descriptor?: IntegrationDescriptor,
    customToken = "",
  ) {
    const authType = surface?.auth?.type ?? "oauth";
    if (!descriptor && (authType === "bearer" || authType === "header") && !customToken.trim()) {
      setCredentialFor(url);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (descriptor) {
        if (await onConnectCatalog?.(descriptor)) setConnected((current) => [...current, url]);
        return;
      }
      const id = await connectRemoteMcp({
        name,
        endpoint: url,
        authType,
        secret: authType === "none" ? undefined : customToken || secret,
        botId,
      });
      if (!id) return;
      setConnected((current) => [...current, url]);
      setCredentialFor(null);
      setToken("");
      await onConnected?.(id);
    } catch {
      setError("connect");
    } finally {
      setBusy(false);
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
              disabled={busy || connected.includes(result.endpoint)}
              onClick={() =>
                void connect(
                  result.name,
                  result.endpoint,
                  result.surface,
                  result.descriptor,
                  credentialFor === result.endpoint ? token : "",
                )
              }
            >
              {connected.includes(result.endpoint) ? t`Connected` : t`Connect`}
            </Button>
          </div>
          {credentialFor === result.endpoint ? (
            <Input
              type="password"
              autoComplete="off"
              aria-label={t`Credential`}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
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
            onChange={(event) => {
              setEndpoint(event.target.value);
              setCredentialFor(null);
            }}
            placeholder="https://example.com/mcp"
          />
          {typedDescriptor ? (
            <p className="text-sm text-muted-foreground">{typedDescriptor.name}</p>
          ) : null}
          <Input
            type="password"
            autoComplete="off"
            aria-label={t`Access token (optional)`}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button
            disabled={busy || !endpoint.trim()}
            onClick={() =>
              void connect(
                typedDescriptor?.name ?? "MCP server",
                endpoint.trim(),
                token.trim()
                  ? {
                      kind: "mcp",
                      slug: "custom",
                      source: endpoint.trim(),
                      auth: { type: "bearer", headerName: null, note: null },
                    }
                  : {
                      kind: "mcp",
                      slug: "custom",
                      source: endpoint.trim(),
                      auth: { type: "none", headerName: null, note: null },
                    },
                typedDescriptor,
                token,
              )
            }
          >
            <Trans>Connect</Trans>
          </Button>
        </div>
      </details>
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
  try {
    const normalized = normalizedEndpoint(endpoint);
    return catalog.find((descriptor) => {
      if (!descriptor.endpoint) return false;
      try {
        return normalizedEndpoint(descriptor.endpoint) === normalized;
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}
