import type { GoalConditionSupport } from "@ardurbot/contracts";
import type { EvidenceRecordView, EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import { Dialog, DialogContent, DialogTitle } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { ArtifactFileCard } from "./ArtifactFileCard";
import { EvidenceStatus } from "./RunEvidence";

export function goalSupportLinkKey(link: GoalConditionSupport) {
  return `${link.kind}:${link.recordId}`;
}

/**
 * The records supporting one reviewed condition. Owner-attested links and bot
 * proposals open the same record viewers the thread uses, beside the review.
 * With `selection`, each chip also carries a checkbox so the owner attests the
 * checked records with the pass/fail decision.
 */
export function GoalConditionSupportChips({
  groupId,
  support,
  proposedSupport,
  selection,
}: {
  groupId: string;
  support: GoalConditionSupport[];
  proposedSupport: GoalConditionSupport[];
  selection?: {
    checked: ReadonlySet<string>;
    onToggle: (key: string) => void;
  };
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState<GoalConditionSupport | null>(null);
  const linkLabel = (link: GoalConditionSupport) =>
    link.kind === "artifact" ? t`Artifact` : link.kind === "run" ? t`Run record` : t`Tool record`;
  const links = selection
    ? [
        ...new Map(
          [...support, ...proposedSupport].map((link) => [goalSupportLinkKey(link), link]),
        ).entries(),
      ].map(([key, link]) => ({
        key,
        link,
        proposed: !support.some((item) => goalSupportLinkKey(item) === key),
      }))
    : [
        ...support.map((link) => ({
          key: `attested:${goalSupportLinkKey(link)}`,
          link,
          proposed: false,
        })),
        ...proposedSupport.map((link) => ({
          key: `proposed:${goalSupportLinkKey(link)}`,
          link,
          proposed: true,
        })),
      ];
  if (links.length === 0) return null;
  return (
    <>
      <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
        {links.map(({ key, link, proposed }) => (
          <span
            key={key}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5"
          >
            {selection ? (
              <input
                type="checkbox"
                className="accent-foreground"
                checked={selection.checked.has(goalSupportLinkKey(link))}
                onChange={() => selection.onToggle(goalSupportLinkKey(link))}
                aria-label={t`Support ${link.recordId}`}
              />
            ) : null}
            <button
              type="button"
              title={link.recordId}
              onClick={() => setOpen(link)}
              className="text-muted-foreground hover:text-foreground"
            >
              {proposed ? (
                <span className="text-muted-foreground/70">
                  <Trans>Proposed</Trans>{" "}
                </span>
              ) : null}
              {linkLabel(link)} {link.recordId.slice(0, 8)}…
            </button>
          </span>
        ))}
      </span>
      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent className="w-[min(560px,94vw)]">
          {open ? (
            <>
              <DialogTitle className="text-sm font-medium">{linkLabel(open)}</DialogTitle>
              <GoalSupportDetails groupId={groupId} link={open} />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function GoalSupportDetails({ groupId, link }: { groupId: string; link: GoalConditionSupport }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; artifact: Awaited<ReturnType<typeof rpc.artifacts.get>> }
    | { status: "summary"; summary: EvidenceRunSummary }
    | { status: "record"; record: EvidenceRecordView }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const load = async () => {
      try {
        if (link.kind === "artifact") {
          const artifact = await rpc.artifacts.get({ groupId, artifactId: link.recordId });
          if (!cancelled) setState({ status: "ready", artifact });
        } else if (link.kind === "run") {
          const summary = await rpc.evidence.runSummary({ runId: link.recordId });
          if (!cancelled) setState({ status: "summary", summary });
        } else {
          const record = await rpc.evidence.record({ recordId: link.recordId });
          if (!cancelled) setState({ status: "record", record });
        }
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [groupId, link]);

  if (state.status === "loading") {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading…</Trans>
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        <Trans>Could not open this record.</Trans>
      </p>
    );
  }
  if (state.status === "ready") {
    const artifact = state.artifact;
    return (
      <div className="flex flex-col gap-2">
        <ArtifactFileCard
          target={{ groupId }}
          artifactId={artifact.id}
          name={artifact.name}
          mimeType={artifact.mimeType}
          size={artifact.size}
        />
        <p className="text-xs text-muted-foreground">
          <Trans>Reviewed revision</Trans>: <span className="font-mono">{link.revision}</span>
        </p>
      </div>
    );
  }
  if (state.status === "summary") {
    const summary = state.summary;
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt>
          <Trans>Status</Trans>
        </dt>
        <dd>
          <EvidenceStatus summary={summary} />
        </dd>
        <dt>
          <Trans>Decisions recorded</Trans>
        </dt>
        <dd>{summary.decisions.recorded.toLocaleString()}</dd>
        <dt>
          <Trans>Recorded</Trans>
        </dt>
        <dd>{new Date(summary.recordedAt).toLocaleString()}</dd>
      </dl>
    );
  }
  const record = state.record;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt>
        <Trans>Tool</Trans>
      </dt>
      <dd className="font-mono">{record.toolName}</dd>
      <dt>
        <Trans>Verdict</Trans>
      </dt>
      <dd className="font-mono">{record.verdict}</dd>
      <dt>
        <Trans>Reviewed revision</Trans>
      </dt>
      <dd className="font-mono">{link.revision}</dd>
    </dl>
  );
}
