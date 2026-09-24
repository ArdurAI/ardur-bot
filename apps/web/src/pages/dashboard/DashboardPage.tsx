import { TEAM_REFRESH_MS } from "@ardurbot/core";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { ErrorInfo, ReactNode } from "react";
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { DashboardPanel, PanelActions } from "./panels";
import { useDashboardPanels } from "./panels";

type Cached = { data: unknown; at: number };
let cacheScope = "";
const cache = new Map<string, Cached>();
export function clearDashboardCache() {
  cache.clear();
  cacheScope = "";
}

const LearningDialog = lazy(() => import("./LearningDialog"));

export function DashboardPage({
  scope,
  spaceId,
  ...actions
}: {
  scope: string;
  spaceId: string;
} & Pick<PanelActions, "openSettings">) {
  const [learningOpen, setLearningOpen] = useState(false);
  const panels = useDashboardPanels();
  if (cacheScope !== scope) {
    cache.clear();
    cacheScope = scope;
  }
  return (
    <section className="min-h-0 flex-1 overflow-auto p-4 md:p-6" data-testid="dashboard">
      <h1 className="mb-5 text-lg font-medium">
        <Trans>Dashboard</Trans>
      </h1>
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">
        {panels.map((panel) => (
          <DashboardPanelView
            key={`${scope}:${panel.id}`}
            panel={panel}
            scope={scope}
            spaceId={spaceId}
            {...actions}
            openLearning={() => setLearningOpen(true)}
          />
        ))}
      </div>
      {learningOpen ? (
        <Suspense fallback={null}>
          <LearningDialog onClose={() => setLearningOpen(false)} />
        </Suspense>
      ) : null}
    </section>
  );
}

export function DashboardPanelView({
  panel,
  scope,
  spaceId,
  ...actions
}: {
  panel: DashboardPanel;
  scope: string;
  spaceId: string;
} & Omit<PanelActions, "refresh">) {
  const { i18n } = useLingui();
  const [value, setValue] = useState<Cached | undefined>(() =>
    cacheScope === scope ? cache.get(panel.id) : undefined,
  );
  const [error, setError] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const lastRead = useRef(value?.at ?? 0);
  const refresh = useCallback((): Promise<void> => {
    if (pending.current) return pending.current;
    const abort = controller.current;
    if (!abort || abort.signal.aborted) return Promise.resolve();
    const request = panel
      .load({ signal: abort.signal, spaceId })
      .then((data) => {
        if (abort.signal.aborted) return;
        const next = { data, at: Date.now() };
        if (cacheScope === scope) cache.set(panel.id, next);
        lastRead.current = next.at;
        setValue(next);
        setError(false);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      })
      .finally(() => {
        if (pending.current === request) pending.current = null;
      });
    pending.current = request;
    return request;
  }, [panel, scope, spaceId]);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    pending.current = null;
    const poll = () => {
      if (!document.hidden && Date.now() - lastRead.current >= TEAM_REFRESH_MS) void refresh();
    };
    poll();
    const timer = setInterval(poll, TEAM_REFRESH_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      abort.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);
  const retry = () => {
    setRenderKey((key) => key + 1);
    void refresh();
  };
  return (
    <section
      data-panel={panel.id}
      data-group={panel.group}
      className={`min-w-0 rounded-xl border border-border bg-card p-4 ${panel.group === "now" ? "lg:col-span-2" : ""}`}
    >
      <h2 className="mb-3 text-sm font-medium">{i18n._(panel.title)}</h2>
      {error ? <PanelError retry={retry} /> : null}
      {!value && !error ? (
        <div
          aria-busy="true"
          className="h-20 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
        />
      ) : null}
      {value ? (
        <PanelBoundary key={renderKey} retry={retry}>
          {value.data === null ? (
            <p className="text-sm text-muted-foreground">{i18n._(panel.empty)}</p>
          ) : (
            panel.render(value.data, { ...actions, refresh })
          )}
        </PanelBoundary>
      ) : null}
    </section>
  );
}

function PanelError({ retry }: { retry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2 text-sm">
      <span>
        <Trans>Could not load</Trans>
      </span>
      <Button variant="ghost" size="sm" onClick={retry}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  );
}
class PanelBoundary extends Component<
  { children: ReactNode; retry: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* The inline retry stays local to this panel. */
  }
  override render() {
    return this.state.failed ? <PanelError retry={this.props.retry} /> : this.props.children;
  }
}
