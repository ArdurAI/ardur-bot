import type { LearningProposal } from "@ardurbot/contracts";
import { Button, Textarea } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useRef, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";

export { MEMORY_IMPORT_PROMPT } from "@ardurbot/contracts";

import { MEMORY_IMPORT_PROMPT } from "@ardurbot/contracts";

export function MemoryImport({
  propose,
  onProposals,
}: {
  propose: (text: string) => Promise<LearningProposal[]>;
  onProposals: (proposals: LearningProposal[]) => void;
}) {
  const { t } = useLingui();
  const pasteId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(MEMORY_IMPORT_PROMPT);
      setCopied(true);
      setError(null);
    } catch {
      setError(t`Could not copy. Select and copy the prompt.`);
    }
  }

  async function submit() {
    if (locked.current || !text.trim()) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      onProposals(await propose(text.trim()));
      setText("");
      setOpen(false);
    } catch {
      setError(t`Could not prepare the import. Try again.`);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-label={t`Import memory from other AI providers`} className="space-y-3 py-4">
      <SettingsRow
        label={t`Import memory from other AI providers`}
        description={t`We'll provide a prompt you can use to fetch the memory from your other account.`}
        content={
          <>
            {open ? (
              <form
                className="space-y-3 rounded-lg border border-border p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <Textarea
                  aria-label={t`Import prompt`}
                  readOnly
                  value={MEMORY_IMPORT_PROMPT}
                  rows={5}
                />
                <Button type="button" variant="outline" onClick={() => void copy()}>
                  {copied ? t`Copied` : t`Copy prompt`}
                </Button>
                <label htmlFor={pasteId} className="block text-sm">
                  <Trans>Paste the response</Trans>
                </label>
                <Textarea
                  id={pasteId}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  maxLength={12000}
                  rows={6}
                  disabled={busy}
                />
                <p className="text-sm text-muted-foreground">
                  <Trans>Review and approve each suggestion before it is saved.</Trans>
                </p>
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy || !text.trim()}>
                    <Trans>Review import</Trans>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      setText("");
                      setError(null);
                    }}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                </div>
              </form>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </>
        }
      >
        {!open ? (
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Trans>Start import</Trans>
          </Button>
        ) : null}
      </SettingsRow>
    </section>
  );
}
