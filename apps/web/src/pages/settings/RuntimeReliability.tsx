import type { RuntimeReliability as Reliability } from "@ardurbot/contracts";
import { runtimeNames } from "@ardurbot/contracts";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { failureCategoryMessages } from "../../lib/failure-category-copy";
import { rpc } from "../../lib/rpc";

export function RuntimeReliability() {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Reliability | null>(null);
  useEffect(() => {
    setReport(null);
    if (!open) return;
    let active = true;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      void rpc.runtimes
        .reliability()
        .then((value) => {
          if (active) setReport(value);
        })
        .catch(() => {
          if (active) setReport(null);
        })
        .finally(() => {
          loading = false;
        });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  return (
    <details
      onToggle={(event) => {
        event.stopPropagation();
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer text-sm text-muted-foreground">
        <Trans>Last 7 days</Trans>
      </summary>
      {open ? (
        <div className="space-y-3 py-2 text-sm">
          {report ? (
            report.runtimes.map((row) => {
              const count = row.measuredRuns;
              return (
                <section key={row.runtimeKind} aria-label={runtimeNames[row.runtimeKind]}>
                  <p>{runtimeNames[row.runtimeKind]}</p>
                  {row.completed + row.failed + row.cancelled === 0 ? (
                    <p className="text-muted-foreground">
                      <Trans>No runs yet</Trans>
                    </p>
                  ) : (
                    <>
                      <dl className="grid grid-cols-2 gap-1 text-muted-foreground">
                        <dt>
                          <Trans>Completed</Trans>
                        </dt>
                        <dd>{row.completed}</dd>
                        <dt>
                          <Trans>Failed</Trans>
                        </dt>
                        <dd>{row.failed}</dd>
                        <dt>
                          <Trans>Cancelled</Trans>
                        </dt>
                        <dd>{row.cancelled}</dd>
                        <dt>
                          <Trans>Success</Trans>
                        </dt>
                        <dd>
                          {row.successRate === null
                            ? t`Not measured`
                            : new Intl.NumberFormat(i18n.locale, {
                                style: "percent",
                                maximumFractionDigits: 0,
                              }).format(row.successRate)}
                        </dd>
                        <dt>
                          <Trans>First reply</Trans>
                        </dt>
                        <dd>
                          {row.firstReplyMedianMs === null
                            ? t`Not measured`
                            : new Intl.NumberFormat(i18n.locale, {
                                style: "unit",
                                unit: "second",
                                maximumFractionDigits: 1,
                              }).format(row.firstReplyMedianMs / 1000)}
                        </dd>
                      </dl>
                      <p className="text-muted-foreground">
                        <Trans>{count} measured runs</Trans>
                      </p>
                      {row.lastFailure ? (
                        <p className="text-muted-foreground">
                          <Trans>Last failure</Trans>:{" "}
                          {i18n._({
                            ...failureCategoryMessages[row.lastFailure.category],
                            values: { runtime: runtimeNames[row.runtimeKind], bot: t`This bot` },
                          })}
                        </p>
                      ) : null}
                    </>
                  )}
                </section>
              );
            })
          ) : (
            <p className="text-muted-foreground">
              <Trans>Not measured</Trans>
            </p>
          )}
        </div>
      ) : null}
    </details>
  );
}
