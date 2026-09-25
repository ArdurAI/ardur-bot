import type { LearningProposal } from "@ardurbot/contracts";
import {
  MEMORY_REVIEW_UNAVAILABLE_MESSAGE,
  MODEL_LOCALITY_DENIED_MESSAGE,
} from "@ardurbot/contracts";
import { Button, Textarea } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";

export function MemoryComposer({
  propose,
  onProposals,
}: {
  propose: (instruction: string) => Promise<LearningProposal[]>;
  onProposals: (proposals: LearningProposal[]) => void;
}) {
  const { t } = useLingui();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState<"runtime" | "locality" | "request" | null>(null);

  async function submit() {
    if (locked.current || !instruction.trim()) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      onProposals(await propose(instruction.trim()));
      setInstruction("");
    } catch (error) {
      setError(
        error instanceof Error && error.message === MEMORY_REVIEW_UNAVAILABLE_MESSAGE
          ? "runtime"
          : error instanceof Error && error.message === MODEL_LOCALITY_DENIED_MESSAGE
            ? "locality"
            : "request",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        aria-label={t`Tell your bot what to change or remove`}
        placeholder={t`Tell your bot what to change or remove`}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        disabled={busy}
        maxLength={4000}
        rows={2}
      />
      <Button type="submit" disabled={busy || !instruction.trim()}>
        <Trans>Send</Trans>
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error === "runtime" ? (
            <Trans>
              Memory review is not available with Claude Code or Codex yet; import memory or edit a
              document directly.
            </Trans>
          ) : error === "locality" ? (
            <Trans>This bot may only run locally — change the pin or the space policy</Trans>
          ) : (
            <Trans>Could not request memory changes. Try again.</Trans>
          )}
        </p>
      ) : null}
    </form>
  );
}
