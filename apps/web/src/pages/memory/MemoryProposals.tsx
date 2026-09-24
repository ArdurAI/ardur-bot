import type { LearningProposal } from "@ardurbot/contracts";
import { learningApprovalBlock } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

export function MemoryProposals({
  proposals,
  onChange,
}: {
  proposals: LearningProposal[];
  onChange: (proposal: LearningProposal) => void;
}) {
  const { t } = useLingui();
  const locked = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(proposal: LearningProposal, action: "approve" | "reject" | "revert") {
    if (locked.current || proposal.type !== "memory") return;
    locked.current = true;
    setBusy(proposal.id);
    setError(null);
    try {
      const result = await rpc.learning[action]({ proposalId: proposal.id });
      onChange(result.proposal);
      if (result.conflict)
        setError(t`The memory changed since this suggestion. Open History before trying again.`);
      window.dispatchEvent(new Event("learning-changed"));
    } catch {
      setError(t`Could not update this suggestion. Try again.`);
    } finally {
      locked.current = false;
      setBusy(null);
    }
  }

  if (!proposals.length) return null;
  return (
    <section aria-label={t`Memory suggestions`} className="space-y-3">
      {proposals.map((proposal) => {
        const supported = proposal.type === "memory" && !learningApprovalBlock(proposal);
        return (
          <article key={proposal.id} className="space-y-3 rounded-lg border border-border p-4">
            <p className="text-sm font-medium">
              {proposal.memoryAction === "delete"
                ? t`Remove memory`
                : proposal.documentKind === "profile"
                  ? t`Profile`
                  : proposal.documentKind === "preferences"
                    ? t`Preferences`
                    : t`Memory`}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm">{proposal.proposedContent}</p>
            <details open={proposal.memoryAction === "delete" || undefined}>
              <summary className="cursor-pointer text-sm">
                <Trans>Details</Trans>
              </summary>
              <p className="my-2 text-sm text-muted-foreground">{proposal.rationale}</p>
              <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
                {proposal.diff}
              </pre>
            </details>
            {proposal.status === "pending" && supported ? (
              <div className="flex gap-2">
                <Button disabled={busy !== null} onClick={() => void act(proposal, "approve")}>
                  <Trans>Approve</Trans>
                </Button>
                <Button
                  disabled={busy !== null}
                  variant="outline"
                  onClick={() => void act(proposal, "reject")}
                >
                  <Trans>Reject</Trans>
                </Button>
              </div>
            ) : proposal.status === "applied" && supported ? (
              <div className="flex items-center gap-3">
                <span className="text-sm">
                  <Trans>Applied</Trans>
                </span>
                <Button
                  disabled={busy !== null}
                  variant="outline"
                  onClick={() => void act(proposal, "revert")}
                >
                  <Trans>Undo</Trans>
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {proposal.status === "rejected"
                  ? t`Rejected`
                  : proposal.status === "reverted"
                    ? t`Undone`
                    : proposal.status === "expired"
                      ? t`Expired`
                      : proposal.status === "superseded"
                        ? t`Superseded`
                        : t`This suggestion cannot be approved here.`}
              </p>
            )}
          </article>
        );
      })}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
