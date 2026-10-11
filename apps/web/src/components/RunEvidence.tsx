import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import {
  EvidenceFingerprintSchema,
  EvidenceRunSummarySchema,
  evidenceIdentityCard,
} from "@ardurbot/contracts/evidence";
import { EVIDENCE_STATES } from "@ardurbot/contracts/evidence-states";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenuItem,
  Input,
} from "@ardurbot/ui-web";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Circle, Download, Loader, Shield, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc, selectedSpaceId } from "../lib/rpc";

// Extractable descriptors translate the shared table's labels without a Lingui dependency there.
const labels = {
  "Evidence off": msg`Evidence off`,
  Recording: msg`Recording`,
  Verified: msg`Verified`,
  "Evidence gap": msg`Evidence gap`,
  "Not sealed": msg`Not sealed`,
  "Check failed": msg`Check failed`,
};
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
      {i18n._(labels[entry.labelMessageId])}
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

const signerLabels = {
  expected_key: msg`Signed by the expected key`,
  different_key: msg`Signed by a different key`,
  no_expected_key: msg`No expected key given; self-consistent only`,
};

export function EvidenceIdentityDetails({
  summary,
  spaceId,
}: {
  summary: EvidenceRunSummary;
  spaceId: string | null;
}) {
  const { i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const [expected, setExpected] = useState("");
  const [checked, setChecked] = useState<{
    expected: string;
    match: EvidenceRunSummary["signerMatch"];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"check" | "copy" | null>(null);
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  const identity = summary.signingIdentity;
  if (summary.state === "off") return null;
  if (!identity && !summary.evidence) return <EvidenceStatus summary={summary} />;
  const fingerprint = expected.trim();
  const valid = !fingerprint || EvidenceFingerprintSchema.safeParse(fingerprint).success;
  const match = summary.sealed
    ? checked?.expected === fingerprint
      ? checked.match
      : !fingerprint
        ? summary.signerMatch
        : null
    : null;
  async function check() {
    const id = ++request.current;
    setBusy(true);
    setError(null);
    setChecked(null);
    try {
      const reply = await rpc.evidence.runSummary(
        {
          runId: summary.sessionId,
          ...(fingerprint ? { expectedFingerprint: fingerprint } : {}),
        },
        { context: { spaceId } },
      );
      if (id !== request.current) return;
      const parsed = EvidenceRunSummarySchema.parse(reply);
      setChecked({ expected: fingerprint, match: parsed.signerMatch });
      if (!parsed.signerMatch) setError("check");
    } catch {
      if (id === request.current) {
        setChecked({ expected: fingerprint, match: null });
        setError("check");
      }
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  async function copy() {
    setError(null);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(identity!.fingerprint);
      setCopied(true);
    } catch {
      setError("copy");
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([evidenceIdentityCard(identity!)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "ardur-signing-identity.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <>
      <Button variant="ghost" size="sm" className="h-auto p-0" onClick={() => setOpen(true)}>
        <EvidenceStatus summary={summary} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>
            <Trans>Signing identity</Trans>
          </DialogTitle>
          {identity && (
            <>
              <dl className="space-y-2 text-sm">
                <dt>
                  <Trans>Fingerprint</Trans>
                </dt>
                <dd className="break-all font-mono">{identity.fingerprint}</dd>
                <dt>
                  <Trans>Space</Trans>
                </dt>
                <dd>{identity.scope.id}</dd>
                <dt>
                  <Trans>Key version</Trans>
                </dt>
                <dd>{identity.keyVersion}</dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void copy()}>
                  {copied ? <Trans>Copied</Trans> : <Trans>Copy fingerprint</Trans>}
                </Button>
                <Button variant="outline" onClick={download}>
                  <Trans>Export identity card</Trans>
                </Button>
              </div>
            </>
          )}
          <Input
            aria-label={i18n._(msg`Expected fingerprint`)}
            placeholder={i18n._(msg`Expected fingerprint`)}
            value={expected}
            maxLength={80}
            onChange={(event) => {
              setExpected(event.target.value);
              setError(null);
            }}
          />
          <Button disabled={!valid || busy} onClick={() => void check()}>
            <Trans>Check key</Trans>
          </Button>
          {match && <p role="status">{i18n._(signerLabels[match])}</p>}
          {error && (
            <p role="alert">
              {error === "copy" ? (
                <Trans>Could not copy. Select the fingerprint and copy it.</Trans>
              ) : (
                <Trans>Check failed</Trans>
              )}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
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
    // Stale answers are ignored rather than aborted: the lookup is small, and aborting it on
    // every remount (a live message finishing, a layout change) shows up as a failed request.
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: IntersectionObserver | undefined;
    let retries = 0;
    async function load() {
      try {
        const reply = await rpc.evidence.runSummary({ runId }, { context: { spaceId } });
        if (stale) return;
        // A reply that is not a summary (an older server, a stub) shows nothing rather than
        // crashing the message list around it.
        const parsed = EvidenceRunSummarySchema.safeParse(reply);
        if (!parsed.success) {
          setResult(null);
          return;
        }
        const summary: EvidenceRunSummary = parsed.data;
        setResult({ runId, spaceId, summary });
        if (
          action === "status" &&
          (live ||
            summary.state === "recording" ||
            (summary.state === "unsealed" && retries++ < 12))
        )
          timer = setTimeout(() => void load(), 5_000);
      } catch {
        if (!stale) setResult(null);
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
      stale = true;
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [runId, spaceId, action, live]);
  const summary = result?.runId === runId && result.spaceId === spaceId ? result.summary : null;
  if (action === "download")
    return summary ? <EvidenceDownload summary={summary} spaceId={spaceId} /> : null;
  return (
    <span ref={marker}>
      {summary ? (
        <EvidenceIdentityDetails key={`${runId}:${spaceId}`} summary={summary} spaceId={spaceId} />
      ) : null}
    </span>
  );
}
