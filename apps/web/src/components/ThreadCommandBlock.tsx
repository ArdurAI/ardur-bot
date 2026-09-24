import type { CommandBlock as RecordedCommand } from "@ardurbot/contracts";
import { commandOutput, commandSummary } from "@ardurbot/core";
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
  const { t } = useLingui();
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
        block={{
          ...block,
          rerunDisabledReason: current ? current.rerunDisabledReason : block.rerunDisabledReason,
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
                <summary className="cursor-pointer break-all">{commandSummary(match)}</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                  {commandOutput(match)}
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
