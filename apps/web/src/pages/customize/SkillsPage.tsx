import type { CustomizationSkill } from "@ardurbot/contracts";
import { Badge, Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopBridge } from "../../lib/desktop";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { LearningInbox } from "../LearningInbox";
import type { SettingsPageProps } from "../settings-types";
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

export default function SkillsPage({
  onBusyChange,
}: Partial<Pick<SettingsPageProps, "onBusyChange">> = {}) {
  const { t, i18n } = useLingui();
  const [tab, setTab] = useState<CatalogTab>("yours");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ListSort>("name");
  const [category, setCategory] = useState("");
  const [skills, setSkills] = useState<CustomizationSkill[]>([]);
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<typeof rpc.customizationSkills.catalog>
  > | null>(null);
  const [opened, setOpened] = useState<CustomizationSkill | null>(null);
  const [inbox, setInbox] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const [failed, setFailed] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const [rows, manifest] = await Promise.all([
      rpc.customizationSkills.list(),
      rpc.customizationSkills.catalog(),
    ]);
    setSkills(rows);
    setCatalog(manifest);
    setFailed(false);
  }, []);
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
  const rows = filterAndSort(skills, query, sort);
  const groups: { kind: CustomizationSkill["kind"]; label: string }[] = [
    { kind: "file", label: t`Created by you` },
    { kind: "taught", label: t`Taught skills` },
    { kind: "learned", label: t`Learned skills` },
  ];
  const native = desktopBridge()?.customization;
  const categories = [...new Set(catalog?.skills.flatMap((entry) => entry.categories) ?? [])];
  const catalogRows = (catalog?.skills ?? [])
    .filter(
      (entry) =>
        (!category || entry.categories.includes(category)) &&
        `${entry.name} ${entry.description}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="space-y-5" aria-label={t`Skills`}>
      <CustomizeToolbar
        tab={tab}
        onTab={setTab}
        query={query}
        onQuery={setQuery}
        sort={sort}
        onSort={setSort}
        filters={tab === "catalog" ? categories : []}
        filter={category}
        onFilter={setCategory}
        searchLabel={t`Search skills and plugins`}
        add={[
          ...(native
            ? [
                {
                  label: t`From folder`,
                  action: () => void action(() => native.importSkills(selectedSpaceId())),
                },
              ]
            : []),
          { label: t`Upload ZIP`, action: () => upload.current?.click() },
        ]}
      />
      <input
        ref={upload}
        hidden
        type="file"
        accept=".zip,application/zip"
        aria-label={t`Upload skills ZIP`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file)
            void action(async () => {
              if (file.size > 9_000_000) throw new Error("The ZIP is too large.");
              const bytes = new Uint8Array(await file.arrayBuffer());
              let binary = "";
              for (let offset = 0; offset < bytes.length; offset += 8192)
                binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
              await rpc.customizationSkills.import({ zip: btoa(binary) });
            });
        }}
      />
      {failed ? <PageError retry={() => void refresh().catch(() => setFailed(true))} /> : null}
      {tab === "yours" ? (
        groups.map((group) => {
          const entries = rows.filter((row) => row.kind === group.kind);
          return (
            <ListSection
              key={group.kind}
              title={group.label}
              count={entries.length}
              extra={
                group.kind === "learned" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setInbox(true)}
                  >{t`Open learning inbox`}</Button>
                ) : undefined
              }
            >
              {entries.length ? (
                entries.map((skill) => (
                  <div key={skill.id} className="flex items-center gap-3 py-3">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        className="max-w-full truncate text-left text-sm font-medium hover:underline"
                        onClick={() =>
                          void action(async () =>
                            setOpened(
                              await rpc.customizationSkills.get({ id: skill.id, kind: skill.kind }),
                            ),
                          )
                        }
                      >
                        {skill.name}
                      </button>
                      <p className="truncate text-xs text-muted-foreground">
                        {t`by you`} · {skill.description}
                      </p>
                    </div>
                    {!skill.enabled ? <Badge variant="secondary">{t`Disabled`}</Badge> : null}
                    <time
                      dateTime={skill.createdAt}
                      className="hidden shrink-0 text-xs text-muted-foreground sm:inline"
                    >
                      {readableDate(skill.createdAt, i18n.locale)}
                    </time>
                    <RowMenu
                      name={skill.name}
                      disabled={busy}
                      actions={[
                        {
                          label: t`Open`,
                          action: () =>
                            void action(async () =>
                              setOpened(
                                await rpc.customizationSkills.get({
                                  id: skill.id,
                                  kind: skill.kind,
                                }),
                              ),
                            ),
                        },
                        {
                          label: skill.enabled ? t`Disable` : t`Enable`,
                          action: () =>
                            void action(() =>
                              rpc.customizationSkills.setEnabled({
                                id: skill.id,
                                kind: skill.kind,
                                enabled: !skill.enabled,
                              }),
                            ),
                        },
                        {
                          label: t`Remove`,
                          disabled: Boolean(skill.pluginId),
                          action: () =>
                            void action(() =>
                              rpc.customizationSkills.remove({ id: skill.id, kind: skill.kind }),
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
        <ListSection title={t`From the catalog`} count={catalogRows.length}>
          {catalogRows.length ? (
            catalogRows.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center gap-3 py-3">
                <FileText className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.name}</p>
                  <p className="text-xs text-muted-foreground">{entry.description}</p>
                </div>
                <div className="flex gap-1">
                  {entry.categories.map((item) => (
                    <Badge key={item} variant="secondary">
                      {item}
                    </Badge>
                  ))}
                </div>
                <Badge variant="outline">{t`Included`}</Badge>
              </div>
            ))
          ) : (
            <EmptyList />
          )}
        </ListSection>
      )}
      {opened ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setOpened(null);
          }}
        >
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{opened.name}</DialogTitle>
            </DialogHeader>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-sm">
              {opened.content}
            </pre>
          </DialogContent>
        </Dialog>
      ) : null}
      {inbox ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setInbox(false);
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t`Learning inbox`}</DialogTitle>
            </DialogHeader>
            <LearningInbox />
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
