import type { CommandBlock as RecordedCommand } from "@ardurbot/contracts";
import { commandDisplayError, commandDisplayOutput, commandSummaryDisplay } from "@ardurbot/core";
import { Button, CommandBlock, Input } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import { rpc } from "../lib/rpc";

export function ThreadCommandBlock({
  block,
  spaceId,
}: {
  block: RecordedCommand;
  spaceId?: string;
}) {
  const { t, i18n } = useLingui();
  const displayError = (record: RecordedCommand) =>
    commandDisplayError(record, (reason) =>
      reason === "command-size"
        ? t`This command was not run because it exceeds 64 KB. Put code in a file and run that file.`
        : t`Use a path inside this bot's folder or a registered folder.`,
    );
  const displayMessage = (message: string | null): string | null =>
    message === "Run commands inside this bot's folder or a registered folder."
      ? t`Run commands inside this bot's folder or a registered folder.`
      : message ===
          "This command was not run because its request is invalid. Check the command and folder."
        ? t`This command was not run because its request is invalid. Check the command and folder.`
        : message;
  const translatedError = (record: RecordedCommand) => {
    const translated = displayError(record);
    return translated === record.error && record.refusalId == null
      ? displayMessage(translated)
      : translated;
  };
  const id = useId();
  const [current, setCurrent] = useState<RecordedCommand | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<RecordedCommand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const reference = { runId: block.runId, commandId: block.commandId };
  const options = { context: { spaceId } };
  const act = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    void work()
      .catch(() => setError(t`This action could not finish; try again.`))
      .finally(() => setBusy(false));
  };
  const download = async (commandId?: string) => {
    const result = await rpc.commands.export({ runId: block.runId, commandId }, options);
    const url = URL.createObjectURL(new Blob([result.text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="w-full min-w-0 space-y-2" aria-busy={busy}>
      <CommandBlock
        locale={i18n.locale}
        displayError={translatedError(block)}
        block={{
          ...block,
          rerunDisabledReason: displayMessage(
            current ? current.rerunDisabledReason : block.rerunDisabledReason,
          ),
        }}
        labels={{
          copyCommand: t`Copy command`,
          copyOutput: t`Copy output`,
          exportRun: t`Export run`,
          exportBlock: t`Export block`,
          rerun: t`Rerun`,
          share: t`Copy block link`,
          search: t`Search run output`,
          notRecorded: t`Not recorded`,
          copyFailed: t`Select the text to copy it.`,
          incomplete: t`Completion not recorded`,
        }}
        rerunPending={current === null}
        onExpand={() =>
          act(async () => {
            setCurrent(null);
            try {
              setCurrent(await rpc.commands.open(reference, options));
            } catch {
              setCurrent({
                ...block,
                rerunDisabledReason: t`Rerun is unavailable; reopen this block to check again.`,
              });
            }
          })
        }
        onExportRun={() => act(() => download())}
        onExportBlock={() => act(() => download(block.commandId))}
        onRerun={() =>
          act(async () => {
            await rpc.commands.rerun(reference, options);
            setStatus(t`Rerun requested.`);
          })
        }
        onShare={() =>
          act(async () => {
            const result = await rpc.commands.share(reference, options);
            await navigator.clipboard.writeText(new URL(result.path, window.location.origin).href);
            setStatus(t`Block link copied.`);
          })
        }
        search={
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              act(async () =>
                setMatches(
                  (await rpc.commands.list({ runId: block.runId, query }, options)).blocks,
                ),
              );
            }}
          >
            <label htmlFor={id} className="text-xs">{t`Search run output`}</label>
            <div className="flex gap-2">
              <Input
                id={id}
                maxLength={256}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button type="submit" variant="outline" disabled={busy}>{t`Search`}</Button>
            </div>
            {matches?.map((match) => (
              <details key={match.commandId} className="text-xs">
                <summary className="cursor-pointer break-all font-mono">
                  {commandSummaryDisplay(match)}
                </summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                  {commandDisplayOutput(match, translatedError(match))}
                </pre>
              </details>
            ))}
            {matches?.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t`No matching output.`}</p>
            ) : null}
          </form>
        }
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
    </div>
  );
}
