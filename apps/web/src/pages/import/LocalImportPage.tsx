import type { McpServer } from "@ardurbot/contracts";
import type {
  LocalImportAction,
  LocalImportCategory,
  LocalImportFailure,
  LocalImportRead,
  LocalImportStop,
  LocalImportSummary,
  LocalImportTool,
} from "@ardurbot/contracts/local-import";
import {
  addLocalImportResult,
  LOCAL_IMPORT_CATEGORIES,
  LOCAL_IMPORT_TOOL_NAMES,
} from "@ardurbot/contracts/local-import";
import { Button, Checkbox, Input, Switch } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { ImportedServerCredentials } from "./ImportedServerCredentials";

type Status = Awaited<ReturnType<typeof rpc.localImport.status>>;
type Selection = Partial<Record<LocalImportTool, LocalImportCategory[]>>;
const defaults: LocalImportCategory[] = ["instructions", "memories", "skills", "servers"];

export function LocalImportPage() {
  const { t } = useLingui();
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState<Selection>({});
  const [folders, setFolders] = useState<Partial<Record<LocalImportTool, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LocalImportStop | null>(null);
  const [preview, setPreview] = useState<LocalImportRead | null>(null);
  const [summary, setSummary] = useState<LocalImportSummary | null>(null);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const labels: Record<LocalImportCategory, string> = {
    instructions: t`Instructions`,
    memories: t`Memories`,
    skills: t`Skills`,
    servers: t`MCP servers`,
    plugins: t`Plugins and extensions`,
    other: t`Other files`,
  };
  const stops: Record<LocalImportStop, string> = {
    host: t`Import could not finish. Check this computer is connected, then re-scan.`,
    rescan: t`This scan is out of date. Re-scan, then try again.`,
    failed: t`Import stopped because of an unexpected error. Re-scan, then try again.`,
  };
  const reasons: Record<LocalImportFailure["reason"], string> = {
    credential: t`Looks like it contains a credential. Remove it from the file, then re-scan.`,
    failed: t`Could not be saved.`,
  };
  useEffect(() => {
    let active = true;
    setBusy(true);
    void (async () => {
      const initial = await rpc.localImport.status();
      if (!active) return;
      if (!initial.manifest) await rpc.localImport.run({ action: "scan" });
      const fresh = await rpc.localImport.status();
      if (active) {
        setStatus(fresh);
        setSelected(fresh.selection);
      }
    })()
      .catch(() => {
        if (active) setError("failed");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStatus(await rpc.localImport.status());
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  }
  function choose(tool: LocalImportTool, category: LocalImportCategory, checked: boolean) {
    const prior = selected;
    const categories = selected[tool] ?? defaults;
    const next = {
      ...selected,
      [tool]: checked
        ? [...categories, category]
        : categories.filter((value) => value !== category),
    };
    setSelected(next);
    if (status?.autoImport)
      void work(async () => {
        try {
          await rpc.localImport.configure({ selection: next });
        } catch (error) {
          setSelected(prior);
          throw error;
        }
      });
  }
  async function run(action: LocalImportAction) {
    await work(async () => {
      setServers(null);
      const response = await rpc.localImport.run(action);
      if (response.stopped) setError(response.stopped);
      if (response.preview) setPreview(response.preview);
      if (response.result) setSummary(addLocalImportResult(null, response));
      if (response.manifest) {
        setPreview(null);
        setSummary(null);
      }
    });
  }
  async function importSelected(tool?: LocalImportTool) {
    const manifest = status?.manifest;
    if (!manifest) return;
    await work(async () => {
      let total: LocalImportSummary | null = null;
      for (const source of manifest.sources.filter((source) => !tool || source.tool === tool)) {
        const categories = selected[source.tool] ?? defaults;
        if (
          !categories.length ||
          !manifest.items.some(
            (item) =>
              item.tool === source.tool && item.importable && categories.includes(item.category),
          )
        )
          continue;
        const response = await rpc.localImport.run({
          action: "import",
          scanId: manifest.scanId,
          tool: source.tool,
          categories,
        });
        total = addLocalImportResult(total, response);
        setSummary(total);
        if (response.stopped) {
          setError(response.stopped);
          return;
        }
      }
    });
  }
  async function retry(failure: LocalImportFailure) {
    const manifest = status?.manifest;
    if (!manifest) return;
    await work(async () => {
      const response = await rpc.localImport.run({
        action: "import",
        scanId: manifest.scanId,
        tool: failure.tool,
        categories: [failure.category],
        itemId: failure.itemId,
      });
      if (response.stopped) setError(response.stopped);
      else setSummary((current) => addLocalImportResult(current, response, failure));
    });
  }
  const manifest = status?.manifest;
  const result = summary?.result;
  const anySelected = manifest?.items.some(
    (item) => item.importable && (selected[item.tool] ?? defaults).includes(item.category),
  );
  return (
    <section className="space-y-5 p-5" data-testid="local-import" aria-busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium">
          {manifest?.platform === "darwin" ? t`Found on this Mac` : t`Found on this computer`}
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void run({ action: "scan" })}>
            <Trans>Re-scan</Trans>
          </Button>
          <Button disabled={busy || !anySelected} onClick={() => void importSelected()}>
            <Trans>Import all</Trans>
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Ardur Bot reads instructions, memories, skills and server lists from these tools on this
          computer and never their sign-ins, tokens or chat history.
        </Trans>
      </p>
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">
          <Trans>Excluded files</Trans>
        </summary>
        <p className="mt-2">
          <Trans>
            Sign-in files (auth.json, credentials and oauth_creds.json), cookies, tokens, credential
            backups, session transcripts, chat histories, history.jsonl, telemetry and caches are
            never read; server lists retain environment variable names only.
          </Trans>
        </p>
      </details>
      {busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Working…</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {stops[error]}
        </p>
      ) : null}
      {manifest?.limited ? (
        <p role="status" className="text-sm text-muted-foreground">
          {manifest.unscanned ? (
            <Trans>
              Some items exceeded the scan limits ({manifest.unscanned} items were not scanned).
            </Trans>
          ) : (
            <Trans>Some items exceeded the scan limits.</Trans>
          )}
        </p>
      ) : null}
      {result ? (
        <p role="status" className="text-sm">
          <Trans>
            {result.created} imported, {result.updated} updated, {result.unchanged} unchanged,{" "}
            {result.removed} removed, {result.skipped} skipped, {result.conflicts} conflicts,{" "}
            {result.failed} failed.
          </Trans>
        </p>
      ) : null}
      {summary?.failures.length ? (
        <ul className="space-y-2 text-sm" aria-label={t`Failed items`}>
          {summary.failures.map((failure) => (
            <li key={failure.itemId} className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block break-all">{failure.relativePath}</span>
                <span className="block text-muted-foreground">{reasons[failure.reason]}</span>
              </span>
              {failure.reason === "failed" ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void retry(failure)}
                  aria-label={t`Retry ${failure.relativePath}`}
                >
                  <Trans>Retry</Trans>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {result && result.conflicts > 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Items edited after import were kept.</Trans>
        </p>
      ) : null}
      {status?.importedAt ? (
        <label
          htmlFor="local-import-auto"
          className="flex items-center justify-between gap-4 text-sm"
        >
          <span>
            <Trans>Auto-import changes</Trans>
          </span>
          <Switch
            id="local-import-auto"
            checked={status.autoImport}
            disabled={busy}
            onCheckedChange={(autoImport) =>
              void work(async () => {
                await rpc.localImport.configure({
                  autoImport,
                  selection: { ...status.selection, ...selected },
                });
              })
            }
          />
        </label>
      ) : null}
      {status?.imported.length ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void work(async () => {
              setServers((await rpc.mcp.servers.list()).filter((server) => server.imported));
            })
          }
        >
          <Trans>Set up servers</Trans>
        </Button>
      ) : null}
      {servers
        ?.filter((server) => server.envKeys.length || server.headerKeys.length)
        .map((server) => (
          <div key={server.id} className="rounded-lg border p-3 text-sm">
            <p>{server.name}</p>
            <ImportedServerCredentials
              server={server}
              onSaved={async () => {
                setServers((await rpc.mcp.servers.list()).filter((value) => value.imported));
              }}
            />
          </div>
        ))}
      {manifest?.sources.map((source) => {
        const name = LOCAL_IMPORT_TOOL_NAMES[source.tool];
        const imported = status?.imported.find((entry) => entry.tool === source.tool)?.count ?? 0;
        return (
          <article
            key={source.tool}
            className="space-y-3 rounded-xl border border-border p-4"
            aria-label={name}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{name}</h3>
              {source.detected ? (
                <Button
                  variant="outline"
                  disabled={busy || !(selected[source.tool] ?? defaults).length}
                  onClick={() => void importSelected(source.tool)}
                  aria-label={t`Import from ${name}`}
                >
                  <Trans>Import</Trans>
                </Button>
              ) : (
                <span className="text-sm text-muted-foreground">
                  <Trans>Not found</Trans>
                </span>
              )}
            </div>
            {source.memoryFolders > 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Memory folders: {source.memoryFolders} · Notes: {source.counts.memories}
                </Trans>
              </p>
            ) : null}
            {LOCAL_IMPORT_CATEGORIES.filter((category) => source.counts[category] > 0).map(
              (category) => {
                const items = manifest.items.filter(
                  (item) => item.tool === source.tool && item.category === category,
                );
                const importable = items.some((item) => item.importable);
                const selection = selected[source.tool] ?? defaults;
                return (
                  <div key={category} className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <Checkbox
                        id={`${source.tool}-${category}`}
                        disabled={busy || !importable}
                        checked={importable && selection.includes(category)}
                        onCheckedChange={(checked) => choose(source.tool, category, checked)}
                      />
                      <label htmlFor={`${source.tool}-${category}`}>
                        {labels[category]} ({source.counts[category]})
                      </label>
                    </div>
                    <details className="text-sm">
                      <summary
                        className="cursor-pointer text-muted-foreground"
                        aria-label={t`Preview ${name} ${labels[category]}`}
                      >
                        <Trans>Preview</Trans>
                      </summary>
                      <ul className="mt-2 max-h-72 space-y-3 overflow-y-auto rounded-lg bg-muted p-3">
                        {items.map((item) => (
                          <li key={item.id} className="space-y-1">
                            {item.importable ? (
                              <Button
                                variant="link"
                                className="h-auto max-w-full justify-start whitespace-normal p-0 text-start"
                                disabled={busy}
                                onClick={() =>
                                  void run({
                                    action: "preview",
                                    scanId: manifest.scanId,
                                    itemId: item.id,
                                  })
                                }
                              >
                                {item.name}
                              </Button>
                            ) : (
                              <p>{item.name}</p>
                            )}
                            <p className="break-all text-xs text-muted-foreground">
                              {item.relativePath}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.size} B · {new Date(item.modifiedAt).toLocaleString()}
                            </p>
                            {item.reason ? (
                              <p className="text-xs text-muted-foreground">{item.reason}</p>
                            ) : null}
                            <code className="block break-all text-xs text-muted-foreground">
                              {item.contentHash}
                            </code>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                );
              },
            )}
            {source.defaultMissing ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  <Trans>Source folder</Trans>
                </summary>
                <form
                  className="mt-2 flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void work(async () => {
                      await rpc.localImport.configure({
                        roots: {
                          ...status?.roots,
                          [source.tool]: folders[source.tool] ?? status?.roots[source.tool] ?? "",
                        },
                      });
                      await rpc.localImport.run({ action: "scan" });
                    });
                  }}
                >
                  <Input
                    aria-label={t`Source folder for ${name}`}
                    value={folders[source.tool] ?? status?.roots[source.tool] ?? ""}
                    placeholder={t`Folder inside your home`}
                    onChange={(event) =>
                      setFolders((current) => ({ ...current, [source.tool]: event.target.value }))
                    }
                    disabled={busy}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={busy || !(folders[source.tool] ?? status?.roots[source.tool])}
                  >
                    <Trans>Use folder</Trans>
                  </Button>
                </form>
              </details>
            ) : null}
            {imported > 0 ? (
              <Button
                variant="ghost"
                className="h-auto whitespace-normal text-start text-destructive"
                disabled={busy}
                onClick={() => void run({ action: "undo", tool: source.tool })}
              >
                <Trans>Remove imported items from {name}</Trans>
              </Button>
            ) : null}
          </article>
        );
      })}
      {preview ? (
        <section
          className="space-y-3 rounded-xl border border-border p-4"
          aria-label={t`Item preview`}
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">{preview.item.name}</h3>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              <Trans>Close preview</Trans>
            </Button>
          </div>
          {preview.server?.envNames.length ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Environment values are requested when you connect this server.</Trans>
            </p>
          ) : null}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
            {preview.content}
          </pre>
        </section>
      ) : null}
    </section>
  );
}
