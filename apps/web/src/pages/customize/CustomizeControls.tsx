import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { ArrowDownAZ, ArrowDownWideNarrow, Ellipsis, ListFilter, Plus } from "lucide-react";
import type { ReactNode } from "react";

export type CatalogTab = "yours" | "catalog";
export type ListSort = "name" | "recent";
export function CustomizeToolbar({
  tab,
  onTab,
  query,
  onQuery,
  sort,
  onSort,
  filters,
  filter,
  onFilter,
  add,
  searchLabel,
}: {
  tab: CatalogTab;
  onTab(value: CatalogTab): void;
  query: string;
  onQuery(value: string): void;
  sort?: ListSort;
  onSort?(value: ListSort): void;
  filters?: string[];
  filter?: string;
  onFilter?(value: string): void;
  add?: { label: string; action(): void }[];
  searchLabel: string;
}) {
  const { t } = useLingui();
  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(value) => onTab(value === "catalog" ? "catalog" : "yours")}>
        <TabsList variant="line" aria-label={t`Source`}>
          <TabsTrigger value="yours">{t`Yours`}</TabsTrigger>
          <TabsTrigger value="catalog">{t`Catalog`}</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-2">
        <Input
          className="min-w-0 flex-1"
          type="search"
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        {onFilter && filters?.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon" aria-label={t`Filter`} />}
            >
              <ListFilter />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onFilter("")}>{t`All categories`}</DropdownMenuItem>
              {filters.map((value) => (
                <DropdownMenuItem
                  key={value}
                  onClick={() => onFilter(value)}
                  aria-current={filter === value ? "true" : undefined}
                >
                  {value}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {onSort ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={sort === "recent" ? t`Sort by name` : t`Sort by newest`}
            onClick={() => onSort(sort === "name" ? "recent" : "name")}
          >
            {sort === "recent" ? <ArrowDownWideNarrow /> : <ArrowDownAZ />}
          </Button>
        ) : null}
        {add?.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <Plus />
              {t`Add`}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {add.map((item) => (
                <DropdownMenuItem key={item.label} onClick={item.action}>
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

export function RowMenu({
  name,
  actions,
  disabled,
}: {
  name: string;
  disabled?: boolean;
  actions: { label: string; action(): void; disabled?: boolean }[];
}) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<Button variant="ghost" size="icon-sm" aria-label={t`Actions for ${name}`} />}
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((item) => (
          <DropdownMenuItem key={item.label} disabled={item.disabled} onClick={item.action}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function ListSection({
  title,
  count,
  children,
  extra,
}: {
  title: string;
  count: number;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {title} <span className="text-muted-foreground">({count})</span>
        </h3>
        {extra}
      </div>
      <div className="divide-y divide-border rounded-lg border border-border px-3">{children}</div>
    </section>
  );
}
export function EmptyList() {
  const { t } = useLingui();
  return <p className="py-6 text-sm text-muted-foreground">{t`No items found.`}</p>;
}
export function PageError({ retry }: { retry(): void }) {
  const { t } = useLingui();
  return (
    <div role="alert" className="flex items-center justify-between gap-2 text-sm">
      <p className="text-destructive">{t`Could not complete this action.`}</p>
      <Button variant="outline" onClick={retry}>{t`Try again`}</Button>
    </div>
  );
}
export function readableDate(value: string, locale?: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.valueOf() > 0
    ? date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })
    : "";
}
export function filterAndSort<
  T extends { name: string; description: string; createdAt: string; category?: string },
>(items: readonly T[], query: string, sort: ListSort, category = ""): T[] {
  const match = query.trim().toLocaleLowerCase();
  return items
    .filter(
      (item) =>
        (!category || item.category === category) &&
        `${item.name} ${item.description}`.toLocaleLowerCase().includes(match),
    )
    .sort(
      (a, b) =>
        (sort === "recent" ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : 0) ||
        a.name.localeCompare(b.name),
    );
}
