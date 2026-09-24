import type { PluginInstall, PluginSummary } from "@ardurbot/contracts";
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
import { Folder, Puzzle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { desktopBridge } from "../../lib/desktop";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import type { CatalogTab, ListSort } from "./CustomizeControls";
import {
  CustomizeToolbar,
  EmptyList,
  filterAndSort,
  ListSection,
  PageError,
  RowMenu,
  readableDate,
} from "./CustomizeControls";
import { ensureCustomizationHost } from "./native";

export function PluginInstallReview({
  summary,
  busy,
  onInstall,
  onClose,
}: {
  summary: PluginSummary;
  busy: boolean;
  onInstall(): void;
  onClose(): void;
}) {
  const { t } = useLingui();
  const groups = [
    { title: t`Skills`, rows: summary.skills },
    { title: t`Commands`, rows: summary.commands },
    { title: t`MCP servers`, rows: summary.servers },
    { title: t`Instructions`, rows: summary.instructions },
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t`Install ${summary.name}`}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{summary.description}</p>
        <div className="max-h-80 space-y-3 overflow-auto">
          {groups.map((group) => (
            <div key={group.title}>
              <h4 className="text-sm font-medium">
                {group.title} ({group.rows.length})
              </h4>
              {group.rows.length ? (
                <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                  {group.rows.map((row) => (
                    <li key={row}>{row}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t`Cancel`}</Button>
          <Button disabled={busy} onClick={onInstall}>{t`Install`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export default function PluginsPage() {
  const { t, i18n } = useLingui();
  const [tab, setTab] = useState<CatalogTab>("yours");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ListSort>("name");
  const [category, setCategory] = useState("");
  const [data, setData] = useState<Awaited<ReturnType<typeof rpc.plugins.list>>>({
    installs: [],
    marketplaces: [],
  });
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<typeof rpc.customizationSkills.catalog>
  > | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof rpc.plugins.preview>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const native = desktopBridge()?.customization;
  const refresh = useCallback(async () => {
    await native?.recoverPlugins(selectedSpaceId());
    const [value, manifest] = await Promise.all([
      rpc.plugins.list(),
      rpc.customizationSkills.catalog(),
    ]);
    setData(value);
    setCatalog(manifest);
    setFailed(false);
  }, [native]);
  useEffect(() => {
    void refresh().catch(() => setFailed(true));
  }, [refresh]);
  async function action(run: () => Promise<unknown>) {
    setBusy(true);
    setFailed(false);
    try {
      await run();
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    if (!preview) return;
    await action(async () => {
      if (native) {
        if (preview.summary.servers.length) await ensureCustomizationHost();
        await native.installPlugin(selectedSpaceId(), preview.id);
      } else await rpc.plugins.install({ previewId: preview.id });
      setPreview(null);
    });
  }
  const rows = filterAndSort(data.installs, query, sort).filter(
    (row) => !category || row.categories.includes(category),
  );
  const categories = [
    ...new Set([
      ...(catalog?.plugins.flatMap((row) => row.categories) ?? []),
      ...data.installs.flatMap((row) => row.categories),
    ]),
  ];
  const groups: { source: PluginInstall["source"]; label: string }[] = [
    { source: "space", label: t`In this space` },
    { source: "catalog", label: t`From the catalog` },
    { source: "marketplace", label: t`From marketplaces you added` },
  ];
  const match = (row: { name: string; description: string; categories: string[] }) =>
    `${row.name} ${row.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) &&
    (!category || row.categories.includes(category));
  return (
    <section aria-label={t`Plugins`} className="space-y-5">
      <CustomizeToolbar
        tab={tab}
        onTab={setTab}
        query={query}
        onQuery={setQuery}
        sort={sort}
        onSort={setSort}
        filters={categories}
        filter={category}
        onFilter={setCategory}
        searchLabel={t`Search skills and plugins`}
        add={[
          { label: t`Add marketplace`, action: () => setAdding(true) },
          ...(native
            ? [
                {
                  label: t`From folder`,
                  action: () => void action(() => native.addMarketplace(selectedSpaceId())),
                },
              ]
            : []),
        ]}
      />
      {failed ? <PageError retry={() => void refresh().catch(() => setFailed(true))} /> : null}
      {tab === "yours" ? (
        groups.map((group) => {
          const entries = rows.filter((row) => row.source === group.source);
          return (
            <ListSection
              key={group.source}
              title={group.label}
              count={entries.length}
              extra={
                group.source === "space" ? (
                  <Badge variant="secondary">
                    <Folder className="size-3" />
                    {t`Current space`}
                  </Badge>
                ) : undefined
              }
            >
              {entries.length ? (
                entries.map((row) => (
                  <div key={row.id} className="flex items-center gap-3 py-3">
                    <Puzzle className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{row.name}</p>
                      {row.state !== "installed" ? (
                        <Badge variant="secondary">
                          {row.state === "installing" ? t`Installing` : t`Removing`}
                        </Badge>
                      ) : null}
                      <p className="truncate text-xs text-muted-foreground">
                        {row.author ? t`by ${row.author}` : t`From the catalog`} · {row.description}
                      </p>
                      <div className="mt-1 flex gap-1">
                        {row.categories.map((category) => (
                          <Badge key={category} variant="secondary">
                            {category}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <time
                      dateTime={row.createdAt}
                      className="hidden text-xs text-muted-foreground sm:block"
                    >
                      {readableDate(row.createdAt, i18n.locale)}
                    </time>
                    <RowMenu
                      name={row.name}
                      disabled={busy}
                      actions={[
                        {
                          label: t`Uninstall`,
                          action: () =>
                            void action(() =>
                              native
                                ? native.uninstallPlugin(selectedSpaceId(), row.id)
                                : rpc.plugins.uninstall({ id: row.id }),
                            ),
                        },
                      ]}
                    />
                  </div>
                ))
              ) : (
                <EmptyList />
              )}
            </ListSection>
          );
        })
      ) : (
        <>
          <ListSection
            title={t`From the catalog`}
            count={(catalog?.plugins ?? []).filter(match).length}
          >
            {(catalog?.plugins ?? []).filter(match).map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 py-3">
                <Puzzle className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.name}</p>
                  <p className="text-xs text-muted-foreground">{entry.description}</p>
                  <div className="mt-1 flex gap-1">
                    {entry.categories.map((category) => (
                      <Badge key={category} variant="secondary">
                        {category}
                      </Badge>
                    ))}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || data.installs.some((row) => row.name === entry.id)}
                  onClick={() =>
                    void action(async () =>
                      setPreview(
                        await rpc.plugins.preview({ name: entry.id, catalogId: entry.id }),
                      ),
                    )
                  }
                >
                  {data.installs.some((row) => row.name === entry.id) ? t`Installed` : t`Install`}
                </Button>
              </div>
            ))}
          </ListSection>
          {data.marketplaces.map((marketplace) => (
            <ListSection
              key={marketplace.id}
              title={marketplace.name}
              count={marketplace.plugins.filter(match).length}
              extra={
                <RowMenu
                  name={marketplace.name}
                  disabled={busy}
                  actions={[
                    {
                      label: t`Remove marketplace`,
                      disabled: data.installs.some((row) => row.marketplaceId === marketplace.id),
                      action: () =>
                        void action(() => rpc.plugins.removeMarketplace({ id: marketplace.id })),
                    },
                  ]}
                />
              }
            >
              {marketplace.plugins.filter(match).map((entry) => (
                <div key={entry.name} className="flex items-center gap-3 py-3">
                  <Puzzle className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{entry.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.author ? t`by ${entry.author}` : marketplace.name} ·{" "}
                      {entry.description}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || data.installs.some((row) => row.name === entry.name)}
                    onClick={() =>
                      void action(async () =>
                        setPreview(
                          await rpc.plugins.preview({
                            name: entry.name,
                            marketplaceId: marketplace.id,
                          }),
                        ),
                      )
                    }
                  >
                    {data.installs.some((row) => row.name === entry.name)
                      ? t`Installed`
                      : t`Install`}
                  </Button>
                </div>
              ))}
            </ListSection>
          ))}
        </>
      )}
      {adding ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setAdding(false);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t`Add marketplace`}</DialogTitle>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  await rpc.plugins.addMarketplace({ url });
                  setAdding(false);
                  setUrl("");
                  setTab("catalog");
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor="marketplace-url">{t`Git URL`}</FieldLabel>
                <Input
                  id="marketplace-url"
                  type="url"
                  required
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://github.com/example/marketplace"
                />
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setAdding(false)}
                >{t`Cancel`}</Button>
                <Button type="submit" disabled={busy}>{t`Add`}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
      {preview ? (
        <PluginInstallReview
          summary={preview.summary}
          busy={busy}
          onClose={() => setPreview(null)}
          onInstall={() => void install()}
        />
      ) : null}
    </section>
  );
}
