import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export function matchesSetting(label: string, query: string) {
  return label
    .normalize("NFKC")
    .toLocaleLowerCase()
    .includes(query.trim().normalize("NFKC").toLocaleLowerCase());
}

const Context = createContext({
  query: "",
  sectionLabel: "",
  targetLabel: null as string | null,
  register:
    (_id: string, _label: string): (() => void) =>
    () =>
      undefined,
});

export function useSettingsSearch() {
  const [query, setQuery] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const register = useCallback((id: string, label: string) => {
    setLabels((value) => ({ ...value, [id]: label }));
    return () =>
      setLabels((value) => {
        const next = { ...value };
        delete next[id];
        return next;
      });
  }, []);
  return {
    query,
    setQuery,
    register,
    rowMatch: Object.values(labels).some((label) => matchesSetting(label, query)),
  };
}

export function SettingsSearchProvider({
  query,
  targetLabel = null,
  sectionLabel,
  register,
  children,
}: {
  query: string;
  targetLabel?: string | null;
  sectionLabel: string;
  register: (id: string, label: string) => () => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ query, targetLabel, sectionLabel, register }),
    [query, targetLabel, sectionLabel, register],
  );
  return <Context value={value}>{children}</Context>;
}

/** Row labels are both the accessible group name and the open page's search index. */
export function SettingsRow({
  label,
  description,
  children,
  content,
}: {
  label: string;
  description?: string;
  children: ReactNode;
  content?: ReactNode;
}) {
  const id = useId();
  const { query, targetLabel, sectionLabel, register } = useContext(Context);
  const row = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (targetLabel !== label) return;
    row.current?.scrollIntoView?.({ block: "center" });
    row.current
      ?.querySelector<HTMLElement>('input:not([aria-hidden="true"]), button, select, textarea')
      ?.focus();
  }, [label, targetLabel]);
  useEffect(() => register(id, label), [id, label, register]);
  const visible = matchesSetting(label, query) || matchesSetting(sectionLabel, query);
  return (
    <fieldset
      ref={row}
      aria-labelledby={id}
      hidden={!visible}
      data-settings-row={label}
      className="min-w-0 border-0 p-0"
    >
      <div className="flex items-center justify-between gap-4 border-b border-border py-4">
        <div className="min-w-0">
          <div id={id} className="text-sm font-medium">
            {label}
          </div>
          {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
      {content}
    </fieldset>
  );
}
