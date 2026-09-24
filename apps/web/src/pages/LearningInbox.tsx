import type {
  LearningGrant,
  LearningGrantInput,
  LearningProposal,
  ProposalEvidence,
  SpaceLearningConfig,
} from "@ardurbot/contracts";
import { learningApprovalBlock } from "@ardurbot/contracts";
import { Button, Switch, Textarea } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";

type Inbox = Awaited<ReturnType<typeof rpc.learning.list>>;
type Conflict = NonNullable<Awaited<ReturnType<typeof rpc.learning.revert>>["conflict"]>;
export function LearningBadge({ botId }: { botId?: string }) {
  const { t } = useLingui();
  const [counts, setCounts] = useState<Pick<Inbox, "pendingCount" | "appliedThisWeek"> | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void rpc.learning
        .summary({ botId })
        .then((value) => {
          if (active) setCounts(value);
        })
        .catch(() => undefined);
    refresh();
    window.addEventListener("learning-changed", refresh);
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("learning-changed", refresh);
    };
  }, [botId]);
  if (!counts) return null;
  return (
    <span className="block truncate whitespace-nowrap text-xs text-muted-foreground">
      {counts.pendingCount > 0 ? t`${counts.pendingCount} suggestions to review` : null}
      {counts.pendingCount > 0 && counts.appliedThisWeek > 0 ? " · " : null}
      {counts.appliedThisWeek > 0 ? t`learned ${counts.appliedThisWeek} things this week` : null}
    </span>
  );
}
export function LearningInbox({ botId }: { botId?: string }) {
  const { t } = useLingui();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [settings, setSettings] = useState<SpaceLearningConfig | null>(null);
  const [grants, setGrants] = useState<LearningGrant[]>([]);
  const [offers, setOffers] = useState<Array<Pick<LearningGrantInput, "category" | "scope">>>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const request = useRef(0);
  const load = useCallback(async () => {
    const current = ++request.current;
    const [list, config, consent] = await Promise.all([
      rpc.learning.list({ botId }),
      rpc.learning.settings(),
      rpc.learning.grants(),
    ]);
    if (current !== request.current) return;
    setInbox(list);
    setSettings(config);
    setGrants(consent.grants);
    setOffers(consent.offers);
  }, [botId]);
  useEffect(() => {
    let active = true;
    void load().catch(() => {
      if (active) setError(true);
    });
    const timer = window.setInterval(() => {
      if (!document.hidden && !busyRef.current) void load().catch(() => undefined);
    }, 15000);
    return () => {
      active = false;
      request.current++;
      window.clearInterval(timer);
    };
  }, [load]);
  async function change(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await action();
      await load();
      window.dispatchEvent(new Event("learning-changed"));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={t`What I learned`} data-testid="learning-inbox" className="space-y-3 py-3">
      <h3 className="text-sm font-medium">
        <Trans>What I learned</Trans>
      </h3>
      {settings ? (
        <div className="flex items-center gap-3">
          {!settings.enabled ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Learning is off for this space.</Trans>
            </p>
          ) : null}
          {settings.canConfigure ? (
            <Switch
              aria-label={t`Learning`}
              checked={settings.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void change(() =>
                  rpc.learning.configure({
                    enabled,
                    reviewerPin: settings.reviewerPin ?? settings.destination,
                    budgets: settings.budgets,
                  }),
                )
              }
            />
          ) : null}
        </div>
      ) : null}
      {settings?.canConfigure && !settings.enabled ? (
        <details className="text-xs text-muted-foreground">
          <summary>
            <Trans>Review destination</Trans>
          </summary>
          <p>
            {settings.destination?.provider} · {settings.destination?.modelId} ·{" "}
            {settings.destination?.effort}
          </p>
          <p>
            <Trans>Reviews use this connection and may incur model charges.</Trans>
          </p>
        </details>
      ) : null}
      {error ? (
        <div role="alert">
          <p>
            <Trans>Could not update learning. Try again.</Trans>
          </p>
          <Button variant="ghost" onClick={() => void change(load)}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      <LearningBadge botId={botId} />
      {inbox?.proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nothing to review.</Trans>
        </p>
      ) : null}
      {inbox?.proposals.map((proposal) => (
        <LearningCard
          key={proposal.id}
          proposal={proposal}
          botName={proposal.scope.botId ? inbox.botNames?.[proposal.scope.botId] : undefined}
          busy={busy}
          change={change}
        />
      ))}
      {offers
        .filter((offer) => !botId || (offer.scope.kind === "bot" && offer.scope.botId === botId))
        .map((offer) => (
          <div
            key={`${offer.category}:${offer.scope.kind === "bot" ? offer.scope.botId : "user"}`}
            className="rounded-lg border p-3 text-sm"
          >
            <p>
              {offer.category === "memory"
                ? offer.scope.kind === "bot"
                  ? t`Apply memory suggestions for this bot automatically`
                  : t`Apply memory suggestions for me automatically`
                : offer.scope.kind === "bot"
                  ? t`Apply skill suggestions for this bot automatically`
                  : t`Apply skill suggestions for me automatically`}
            </p>
            {offer.scope.kind === "bot" ? (
              <span className="text-xs text-muted-foreground">
                {inbox?.botNames?.[offer.scope.botId] ?? offer.scope.botId}
              </span>
            ) : null}
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  void change(() =>
                    rpc.learning.createGrant({ ...offer, limits: { maxPerDay: 5 } }),
                  )
                }
              >
                <Trans>Turn on</Trans>
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void change(() => rpc.learning.declineGrant(offer))}
              >
                <Trans>Not now</Trans>
              </Button>
            </div>
          </div>
        ))}
      {grants
        .filter(
          (grant) =>
            !grant.revokedAt && (!grant.expiresAt || new Date(grant.expiresAt) > new Date()),
        )
        .map((grant) => (
          <div key={grant.id} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {grant.category} ·{" "}
              {grant.scope.kind === "bot"
                ? (inbox?.botNames?.[grant.scope.botId] ?? grant.scope.botId)
                : t`Personal`}{" "}
              · {t`${grant.limits.maxPerDay} per day`}
            </span>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void change(() => rpc.learning.revokeGrant({ grantId: grant.id }))}
            >
              <Trans>Revoke</Trans>
            </Button>
          </div>
        ))}
    </section>
  );
}
function LearningCard({
  proposal,
  botName,
  busy,
  change,
}: {
  proposal: LearningProposal;
  botName?: string;
  busy: boolean;
  change: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.proposedContent ?? "");
  const [settingValue, setSettingValue] = useState(proposal.typedDelta?.value === true);
  const [evidence, setEvidence] = useState<ProposalEvidence | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const blocked = learningApprovalBlock(proposal);
  const pending = proposal.status === "pending";
  return (
    <article
      className="rounded-lg border p-3 motion-safe:animate-in motion-safe:fade-in duration-100 motion-reduce:animate-none"
      data-status={proposal.status}
    >
      <p className="truncate text-sm font-medium">
        {proposal.proposedContent?.split("\n").find((line) => line.trim() && line !== "---") ??
          proposal.typedDelta?.key ??
          proposal.type}
      </p>
      <p className="text-xs text-muted-foreground">
        {proposal.scope.botId
          ? t`Bot: ${botName ?? proposal.scope.botId}`
          : proposal.scope.userId
            ? t`Personal`
            : t`Shared`}
      </p>
      <div className="flex min-h-10 items-center gap-2">
        {pending ? (
          <>
            <Button
              disabled={busy || !!blocked || editing}
              onClick={() => void change(() => rpc.learning.approve({ proposalId: proposal.id }))}
            >
              <Trans>Approve</Trans>
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void change(() => rpc.learning.reject({ proposalId: proposal.id }))}
            >
              <Trans>Reject</Trans>
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !!blocked}
              onClick={() => setEditing((value) => !value)}
            >
              <Trans>Edit</Trans>
            </Button>
          </>
        ) : proposal.status === "applied" ? (
          <>
            <span className="text-sm">
              <Trans>Applied</Trans>
            </span>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void change(async () => {
                  const result = await rpc.learning.revert({ proposalId: proposal.id });
                  setConflict(result.conflict ?? null);
                })
              }
            >
              <Trans>Undo</Trans>
            </Button>
          </>
        ) : (
          <span className="text-sm">
            {proposal.status === "reverted"
              ? t`Undone`
              : proposal.status === "rejected"
                ? t`Rejected`
                : proposal.status === "superseded"
                  ? t`Superseded`
                  : t`Expired`}
          </span>
        )}
      </div>
      {blocked ? <p className="text-xs text-muted-foreground">{blocked}</p> : null}
      {editing ? (
        <div>
          {proposal.typedDelta ? (
            <Switch
              aria-label={proposal.typedDelta.key}
              checked={settingValue}
              onCheckedChange={setSettingValue}
            />
          ) : (
            <Textarea
              aria-label={t`Suggested content`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          <Button
            disabled={busy}
            onClick={() =>
              void change(async () => {
                await rpc.learning.edit({
                  proposalId: proposal.id,
                  edits: proposal.typedDelta
                    ? { typedDelta: { key: proposal.typedDelta.key, value: settingValue } }
                    : { proposedContent: draft },
                });
                setEditing(false);
              })
            }
          >
            <Trans>Save</Trans>
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : null}
      <details className="mt-2 text-xs">
        <summary>
          <Trans>Details</Trans>
        </summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap py-2">{proposal.diff}</pre>
        <p>{proposal.rationale}</p>
        <p>
          <Trans>model estimate</Trans>: {Math.round(proposal.confidence.value * 100)}%
        </p>
        <p>
          <Trans>Base revision</Trans>: {proposal.expectedBaseRevision ?? 0}
        </p>
        {proposal.evidenceIds.map((id) => (
          <Button
            key={id}
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void change(async () =>
                setEvidence(
                  await rpc.learning.evidence({ proposalId: proposal.id, evidenceId: id }),
                ),
              )
            }
          >
            <Trans>Evidence</Trans> {id.slice(0, 8)}
          </Button>
        ))}
        {evidence ? (
          <div>
            <p>
              {evidence.sourceClass} · {evidence.runId}
            </p>
            <p>
              {evidence.excerpt ??
                `${evidence.outcome?.category}: ${evidence.outcome?.classification}`}
            </p>
          </div>
        ) : null}
        {proposal.provenance ? (
          <div className="space-y-1">
            <p>
              <Trans>Originating run</Trans>: {proposal.provenance.runId} ·{" "}
              {proposal.provenance.originatingPin?.modelId} ·{" "}
              {proposal.provenance.originatingPin?.effort}
            </p>
            <p>
              <Trans>Reviewer</Trans>: {proposal.provenance.reviewerPin.provider} ·{" "}
              {proposal.provenance.reviewerPin.modelId} · {proposal.provenance.reviewerPin.effort}
            </p>
            <p>
              <Trans>Policy version</Trans>: {proposal.provenance.policyVersion}
            </p>
          </div>
        ) : null}
        {proposal.appliedRevisionId ? (
          <p>
            <Trans>Revision</Trans>: {proposal.appliedRevisionId}
          </p>
        ) : null}
        {proposal.status === "applied" ? (
          <p>
            <Trans>no observations yet</Trans>
          </p>
        ) : null}
      </details>
      {conflict ? (
        <div role="alert" className="mt-3 text-sm">
          <p>
            <Trans>Later edits overlap this change. Review both versions in History.</Trans>
          </p>
          <p>
            <Trans>Before</Trans>
          </p>
          <pre className="whitespace-pre-wrap">{conflict.before}</pre>
          <p>
            <Trans>Applied</Trans>
          </p>
          <pre className="whitespace-pre-wrap">{conflict.applied}</pre>
          <p>
            <Trans>Current</Trans>
          </p>
          <pre className="whitespace-pre-wrap">{conflict.current}</pre>
        </div>
      ) : null}
    </article>
  );
}
