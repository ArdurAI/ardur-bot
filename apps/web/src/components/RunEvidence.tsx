import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import { EVIDENCE_STATES } from "@ardurbot/contracts/evidence-states";
import { DropdownMenuItem } from "@ardurbot/ui-web";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Circle, Download, Loader, Shield, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";

// Explicit ids let the shared browser-safe table own state labels without depending on Lingui.
const labels = [
  msg({ id: "Evidence off", message: "Evidence off" }),
  msg({ id: "Recording", message: "Recording" }),
  msg({ id: "Verified", message: "Verified" }),
  msg({ id: "Evidence gap", message: "Evidence gap" }),
  msg({ id: "Not sealed", message: "Not sealed" }),
  msg({ id: "Check failed", message: "Check failed" }),
];
const icons = {
  circle: Circle,
  loader: Loader,
  shield: Shield,
  "shield-check": ShieldCheck,
  "shield-alert": ShieldAlert,
  "shield-x": ShieldX,
};

export function EvidenceStatus({ summary }: { summary: EvidenceRunSummary }) {
  const { i18n } = useLingui();
  if (summary.state === "off") return null;
  const entry = EVIDENCE_STATES[summary.state];
  const Icon = icons[entry.icon];
  const gapCount = summary.gapCount;
  const title =
    summary.state === "gap"
      ? i18n._(msg`${gapCount} evidence gaps`)
      : summary.failureCodes.join(", ") || undefined;
  return (
    <span
      data-evidence-state={summary.state}
      title={title}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
    >
      <Icon size={13} aria-hidden="true" />
      {i18n._(labels.find((label) => label.id === entry.labelMessageId)!)}
    </span>
  );
}

export function EvidenceDownload({
  summary,
  spaceId,
}: {
  summary: EvidenceRunSummary;
  spaceId: string | null;
}) {
  if (!summary.sealed) return null;
  const query = new URLSearchParams(spaceId ? { spaceId } : {});
  const href = `/api/evidence/runs/${encodeURIComponent(summary.sessionId)}?${query}`;
  return (
    <DropdownMenuItem
      render={<a href={href} download={`ardur-evidence-${summary.sessionId}.tar.gz`} />}
    >
      <Download size={14} aria-hidden="true" />
      <Trans>Download evidence</Trans>
    </DropdownMenuItem>
  );
}

/** Mounted behind the run view's lazy boundary; only visible runs request summaries. */
export default function RunEvidence({
  runId,
  action = "status",
  live = false,
}: {
  runId: string;
  action?: "status" | "download";
  live?: boolean;
}) {
  const spaceId = selectedSpaceId();
  const marker = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<{
    runId: string;
    spaceId: string | null;
    summary: EvidenceRunSummary;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: IntersectionObserver | undefined;
    let retries = 0;
    async function load() {
      try {
        const summary = await rpc.evidence.runSummary(
          { runId },
          { signal: controller.signal, context: { spaceId } },
        );
        if (controller.signal.aborted) return;
        setResult({ runId, spaceId, summary });
        if (
          action === "status" &&
          (live ||
            summary.state === "recording" ||
            (summary.state === "unsealed" && retries++ < 12))
        )
          timer = setTimeout(() => void load(), 5_000);
      } catch {
        if (!controller.signal.aborted) setResult(null);
      }
    }
    if (action === "download" || typeof IntersectionObserver === "undefined") void load();
    else if (marker.current) {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        void load();
      });
      observer.observe(marker.current);
    }
    return () => {
      controller.abort();
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [runId, spaceId, action, live]);
  const summary = result?.runId === runId && result.spaceId === spaceId ? result.summary : null;
  if (action === "download")
    return summary ? <EvidenceDownload summary={summary} spaceId={spaceId} /> : null;
  return <span ref={marker}>{summary ? <EvidenceStatus summary={summary} /> : null}</span>;
}
