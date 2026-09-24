import type { TeamRow } from "@ardurbot/contracts";
import { runtimeEffortLabel, sortTeamRows, TEAM_REFRESH_MS } from "@ardurbot/core";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { decodeArtifactBase64, downloadArtifactBytes } from "../lib/artifact-open";
import { rpc } from "../lib/rpc";
import { ComparisonList } from "./ComparePanel";
import { CompareStart } from "./CompareStart";

export function TeamBoard({ navigation }: { navigation?: ReactNode }) {
  const [rows, setRows] = useState<TeamRow[]>([]);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const result = await rpc.team.board({});
      if (alive.current) {
        setRows(sortTeamRows(result.rows));
        setLoaded(true);
        setError(false);
      }
    } catch {
      if (alive.current) setError(true);
    } finally {
      pending.current = false;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    // Roster changes have no space-wide stream; this also repairs unavailable thread streams.
    const timer = setInterval(() => void refresh(), TEAM_REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const subscriptionRows = useRef(rows);
  subscriptionRows.current = rows;
  const subscriptions = rows
    .filter((row) => row.threadId)
    .map((row) => row.botId)
    .sort()
    .join(",");
  useEffect(() => {
    const abort = new AbortController();
    for (const botId of subscriptions.split(",")) {
      const row = subscriptionRows.current.find((item) => item.botId === botId);
      if (!row?.threadId) continue;
      void (async () => {
        try {
          const events = await rpc.threads.subscribe(
            { botId: row.botId, cursor: row.cursor },
            { signal: abort.signal },
          );
          for await (const _event of events) {
            if (abort.signal.aborted) break;
            void refresh();
          }
        } catch {
          /* The foreground refresh remains available. */
        }
      })();
    }
    return () => abort.abort();
  }, [subscriptions, refresh]);
  const list = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (const element of list.current?.querySelectorAll<HTMLElement>("[data-team-bot]") ?? []) {
      const id = element.dataset.teamBot!;
      const top = element.getBoundingClientRect().top;
      const before = positions.current.get(id);
      next.set(id, top);
      if (
        before !== undefined &&
        before !== top &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        element.animate(
          [{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }],
          {
            duration: Number.parseFloat(getComputedStyle(element).transitionDuration) * 1000,
            easing: "ease-out",
          },
        );
    }
    positions.current = next;
  }, [rows]);
  return (
    <section className="min-h-0 flex-1 overflow-auto p-4" aria-label="Team">
      <div className="mb-4 flex items-center gap-2">
        {navigation}
        <h1 className="text-lg font-medium">
          <Trans>Team</Trans>
        </h1>
      </div>
      {error ? (
        <Button onClick={() => void refresh()}>
          <Trans>Could not load Team; retry.</Trans>
        </Button>
      ) : null}
      {!loaded && !error ? (
        <div className="h-20 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      ) : null}
      <ComparisonList />
      <div ref={list} className="space-y-2">
        {rows.map((row) => (
          <TeamBoardRow key={row.botId} row={row} refresh={refresh} />
        ))}
      </div>
    </section>
  );
}
export function TeamBoardRow({ row, refresh }: { row: TeamRow; refresh: () => Promise<void> }) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const card = row.delegations.find((item) => item.id === row.delegationId)?.card;
  const act = async (action: "stop" | "accept") => {
    setBusy(true);
    setError(false);
    try {
      if (action === "stop" && row.rootTaskId)
        await rpc.delegations.cancel({ rootTaskId: row.rootTaskId });
      if (action === "accept" && row.delegationId)
        await rpc.delegations.accept({ id: row.delegationId });
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      data-team-bot={row.botId}
      className="rounded-lg border border-border bg-card transition-transform duration-200 motion-reduce:transition-none"
    >
      <details>
        <summary className="flex h-20 cursor-pointer items-center gap-3 px-4">
          <span className="w-28 shrink-0 truncate font-medium">{row.botName}</span>
          <span className="min-w-0 flex-1 truncate text-sm">
            <TeamStatus row={row} />
          </span>
        </summary>
        <div className="space-y-4 border-t border-border p-4 text-sm">
          {row.chain.length ? <p>{row.chain.map((entry) => entry.name).join(" → ")}</p> : null}
          {row.state === "waiting-approval" && row.requesterName ? (
            <p>
              <Trans>
                Requested by {row.requesterName} — acting as {row.botName}
              </Trans>
            </p>
          ) : null}
          {card ? (
            <>
              <p>{row.sentence}</p>
              <CompareStart botId={row.botId} delegationId={row.delegationId ?? undefined} />
              {card.responsibleUserId ? (
                <p>
                  <Trans>Responsible human</Trans>: {card.responsibleUserId}
                </p>
              ) : null}
              <ul>
                {card.doneWhen.map((item, index) => {
                  const report = card.reports.find((entry) => entry.index === index);
                  return (
                    <li key={`${index}:${item}`}>
                      {item} —{" "}
                      {report ? (
                        <>
                          {report.met ? t`Reported met` : t`Reported unmet`}: {report.report}
                        </>
                      ) : (
                        t`Not reported`
                      )}
                    </li>
                  );
                })}
              </ul>
              <details>
                <summary>
                  <Trans>Inputs and boundaries</Trans>
                </summary>
                <ul>
                  {card.inputs.map((input, index) => (
                    <li key={`${input.type}:${index}`}>
                      {input.type === "text"
                        ? input.text
                        : input.type === "file"
                          ? input.artifactId
                          : input.type === "url"
                            ? input.url
                            : `${input.documentId} · ${input.revision}`}
                    </li>
                  ))}
                </ul>
                <p>{card.approvalBoundaries.scopes.join(", ")}</p>
                <p>{card.approvalBoundaries.connectors.join(", ")}</p>
                <p>
                  <Trans>Budget</Trans>: {card.budget.tokens} · {card.budget.deadlineAt}
                </p>
              </details>
              <details>
                <summary>
                  <Trans>Timeline</Trans>
                </summary>
                <ol>
                  {card.timeline.map((event) => (
                    <li key={event.id}>
                      <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time> ·{" "}
                      {event.kind}
                      {event.text ? ` — ${event.text}` : ""}
                    </li>
                  ))}
                </ol>
              </details>
              {card.artifacts.length ? (
                <div>
                  <Trans>Artifacts</Trans>
                  <ul>
                    {card.artifacts.map((id) => (
                      <li key={id}>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={async () => {
                            try {
                              const artifact = await rpc.artifacts.get({
                                ...(row.groupId ? { groupId: row.groupId } : { botId: row.botId }),
                                artifactId: id,
                              });
                              downloadArtifactBytes(
                                artifact.name,
                                artifact.mimeType,
                                decodeArtifactBase64(artifact.contentBase64),
                              );
                            } catch {
                              setError(true);
                            }
                          }}
                        >
                          {id}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
          {row.executing ? (
            <details>
              <summary>
                <Trans>Executing</Trans>
              </summary>
              <dl className="grid grid-cols-2 gap-2">
                <dt>
                  <Trans>Provider</Trans>
                </dt>
                <dd>{row.executing.pin.provider}</dd>
                <dt>
                  <Trans>Model</Trans>
                </dt>
                <dd>{row.executing.pin.modelId}</dd>
                <dt>
                  <Trans>Effort</Trans>
                </dt>
                <dd>
                  {runtimeEffortLabel(row.executing.pin, row.executing.runtimeInfo, t`requested`) ??
                    "—"}
                </dd>
                <dt>
                  <Trans>Runtime</Trans>
                </dt>
                <dd>{row.executing.pin.runtimeKind}</dd>
                <dt>
                  <Trans>Computer</Trans>
                </dt>
                <dd>
                  {row.executing.computer.kind} · {row.executing.computer.id ?? "—"}
                </dd>
              </dl>
            </details>
          ) : null}
          <p>
            <Trans>Tokens</Trans>: {row.usage.tokens}
          </p>
          {row.usage.costs.map((cost, index) => (
            <p key={`${index}:${cost.amount}`}>
              <Trans>Cost</Trans>: {cost.amount} · {cost.provenance}
            </p>
          ))}
        </div>
      </details>
      {row.canStop || row.canAccept || row.action ? (
        <div className="flex min-h-10 items-center gap-2 px-4 pb-2">
          {row.canStop ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("stop")}>
              <Trans>Stop</Trans>
            </Button>
          ) : null}
          {row.canAccept ? (
            <Button size="sm" disabled={busy} onClick={() => void act("accept")}>
              <Trans>Accept</Trans>
            </Button>
          ) : null}
          {row.action ? (
            <Link
              className="text-sm underline"
              to={`/app/${row.chain.find((item) => item.role === "reviewer")?.id ?? row.botId}`}
            >
              {row.state === "waiting-approval" ? t`Review approval` : row.action}
            </Link>
          ) : null}
          {error ? (
            <span role="alert">
              <Trans>Could not update this task; try again.</Trans>
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
function TeamStatus({ row }: { row: TeamRow }) {
  switch (row.state) {
    case "idle":
      return <Trans>Idle</Trans>;
    case "queued":
      return <Trans>Queued</Trans>;
    case "working":
      return row.sentence ? (
        <Trans>
          Working on {row.sentence} for {row.requesterName}
        </Trans>
      ) : (
        <Trans>Working</Trans>
      );
    case "waiting-approval":
      return <Trans>Waiting for approval</Trans>;
    case "blocked":
      return <Trans>Blocked — {row.reason}</Trans>;
    case "completed":
      return <Trans>Done — waiting for your OK</Trans>;
    case "accepted":
      return <Trans>Accepted</Trans>;
  }
}
