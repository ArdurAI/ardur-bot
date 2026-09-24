import type { Bot, IdeEntry } from "@ardurbot/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import type { EditorSelection } from "./editor";
import { quickMatches, scanFiles } from "./model";

export function QuickOpen({
  list,
  onOpen,
  onClose,
  onError,
}: {
  list(path: string): Promise<IdeEntry[]>;
  onOpen(path: string): void;
  onClose(): void;
  onError(error: unknown): void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<IdeEntry[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    void scanFiles(list, abort.signal, (rows) => setFiles((current) => [...current, ...rows]))
      .catch((error) => {
        if (!abort.signal.aborted) onError(error);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [list, onError]);
  const matches = quickMatches(files, query);
  const choose = (path: string) => {
    onOpen(path);
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{t`Quick open`}</DialogTitle>
        <Input
          aria-label={t`Quick open`}
          autoFocus
          value={query}
          aria-controls="ide-quick-results"
          aria-activedescendant={matches[selected] ? `ide-result-${selected}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((index) =>
                Math.max(
                  0,
                  Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                ),
              );
            }
            if (event.key === "Enter" && matches[selected]) {
              event.preventDefault();
              choose(matches[selected]!.path);
            }
          }}
        />
        <div
          role="listbox"
          id="ide-quick-results"
          aria-label={t`Quick open`}
          aria-busy={busy}
          className="max-h-80 overflow-auto"
        >
          {matches.map((file, index) => (
            <button
              type="button"
              role="option"
              id={`ide-result-${index}`}
              aria-selected={index === selected}
              key={file.path}
              onClick={() => choose(file.path)}
              className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${index === selected ? "bg-accent" : ""}`}
            >
              {file.path}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AskBot({
  bots,
  selection,
  path,
  onSend,
  onClose,
}: {
  bots: Bot[];
  selection: EditorSelection;
  path: string;
  onSend(botId: string, instruction: string): Promise<void>;
  onClose(): void;
}) {
  const { t } = useLingui();
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{t`Ask a bot`}</DialogTitle>
        <p className="truncate text-sm text-muted-foreground" title={path}>
          {path}:{selection.startLine}-{selection.endLine}
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !botId || !instruction.trim()) return;
            setBusy(true);
            setError(null);
            void onSend(botId, instruction)
              .then(onClose)
              .catch((error) =>
                setError(
                  error instanceof Error
                    ? error.message
                    : t`This action could not finish; try again.`,
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <NativeSelect
            aria-label={t`Bots`}
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
          >
            {bots.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Textarea
            aria-label={t`Ask a bot`}
            autoFocus
            maxLength={2000}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            disabled={busy || !botId || !instruction.trim()}
          >{t`Ask a bot`}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
