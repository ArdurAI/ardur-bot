import type { IntegrationCatalogResult } from "@ardurbot/contracts";
import { Button, Input } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { connectRemoteMcp } from "./connect-remote-mcp";

export function DirectMcpSearch({
  botId,
  secret = "",
  onConnected,
}: {
  botId?: string;
  secret?: string;
  onConnected?: (serverId: string) => void | Promise<void>;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IntegrationCatalogResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const remoteResults = [
    ...new Map(
      results.flatMap((result) =>
        result.surfaces
          .filter((surface) => surface.kind === "mcp" && surface.source?.startsWith("https://"))
          .map(
            (surface) =>
              [surface.source!, { name: result.name, endpoint: surface.source! }] as const,
          ),
      ),
    ).values(),
  ];

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not connect`);
    } finally {
      setBusy(false);
    }
  }

  async function connect(name: string, url: string) {
    await run(async () => {
      const id = await connectRemoteMcp({ name, endpoint: url, secret, botId });
      if (!id) return;
      setConnected((current) => [...current, url]);
      await onConnected?.(id);
    });
  }

  return (
    <div className="space-y-6">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const response = await rpc.capabilities.catalogSearch({
              query,
              usePublicCatalog: true,
            });
            setResults(response.results);
            setSearched(true);
          });
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
        <div key={result.endpoint} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">{result.name}</span>
          <Button
            variant="outline"
            disabled={busy || connected.includes(result.endpoint)}
            onClick={() => void connect(result.name, result.endpoint)}
          >
            {connected.includes(result.endpoint) ? t`Connected` : t`Connect`}
          </Button>
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
          <Button
            disabled={busy || !endpoint.trim()}
            onClick={() => void connect("MCP server", endpoint.trim())}
          >
            <Trans>Connect</Trans>
          </Button>
        </div>
      </details>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
