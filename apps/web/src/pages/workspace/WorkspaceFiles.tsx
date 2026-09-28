import type { Bot, IdeEntry, WorkspaceContext } from "@ardurbot/contracts";
import { ideHandoffText } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { AskBot, QuickOpen } from "../ide/dialogs";
import type { EditorHandle, EditorSelection } from "../ide/editor";
import { FileTree } from "../ide/file-tree";
import { basename } from "../ide/model";

const Editor = lazy(() => import("../ide/editor"));
type OpenFile = { path: string; content: string; source: "live" | "saved" };

export function WorkspaceFiles({ bot, context }: { bot: Bot; context: WorkspaceContext }) {
  const { t } = useLingui();
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [active, setActive] = useState("");
  const [quick, setQuick] = useState(false);
  const [ask, setAsk] = useState<{ selection: EditorSelection; path: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const editor = useRef<EditorHandle>(null);
  const current = tabs.find((file) => file.path === active);
  const valid =
    context.computerId && context.generation !== null && context.files !== "unavailable";
  useEffect(() => {
    setTabs([]);
    setActive("");
    setError(null);
    setNotice(null);
  }, [bot.id, context.computerId, context.generation, context.files]);
  const onError = useCallback(() => setError(t`Could not load files. Try again.`), [t]);
  const list = useCallback(
    async (path: string): Promise<IdeEntry[]> => {
      if (!context.computerId || context.generation === null) return [];
      const result = await rpc.workspace.list({
        botId: bot.id,
        computerId: context.computerId,
        generation: context.generation,
        path,
      });
      return result.entries;
    },
    [bot.id, context.computerId, context.generation, revision],
  );
  const open = useCallback(
    (path: string) => {
      if (!context.computerId || context.generation === null) return;
      if (tabs.some((file) => file.path === path)) {
        setActive(path);
        return;
      }
      void rpc.workspace
        .read({
          botId: bot.id,
          computerId: context.computerId,
          generation: context.generation,
          path,
        })
        .then((result) => {
          setTabs((files) =>
            files.some((file) => file.path === path)
              ? files
              : [
                  ...files,
                  {
                    path,
                    content: result.content,
                    source: result.context.files === "live" ? "live" : "saved",
                  },
                ],
          );
          setActive(path);
          setError(null);
        })
        .catch(onError);
    },
    [bot.id, context.computerId, context.generation, tabs, onError],
  );
  useEffect(() => {
    const hotkey = (event: KeyboardEvent) => {
      if (
        !event.target ||
        !(event.target instanceof Element) ||
        !event.target.closest("[data-workspace-files]")
      )
        return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.isComposing)
        return;
      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuick(true);
      } else if (event.key.toLowerCase() === "f") {
        if (current) {
          event.preventDefault();
          editor.current?.find();
        }
      } else if (event.key.toLowerCase() === "s" && current) {
        event.preventDefault();
        setNotice(t`Read only in this pane. Open IDE to edit.`);
      }
    };
    window.addEventListener("keydown", hotkey, true);
    return () => window.removeEventListener("keydown", hotkey, true);
  }, [current, t]);
  if (!valid)
    return (
      <p className="p-4 text-sm text-muted-foreground">{t`Files are unavailable on this computer.`}</p>
    );
  return (
    <div data-workspace-files className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1 text-xs text-muted-foreground">
        <span>{context.files === "live" ? t`Live files` : t`Saved files`}</span>
        <div className="flex gap-1">
          <Button variant="ghost" size="xs" onClick={() => setQuick(true)}>{t`Quick open`}</Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setRevision((value) => value + 1)}
          >{t`Refresh`}</Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="h-40 shrink-0 border-b border-border overflow-auto">
          <FileTree
            key={`${context.computerId}:${revision}`}
            label={t`Files`}
            list={list}
            onOpen={open}
            onError={onError}
            selected={active}
          />
        </div>
        <div
          role="tablist"
          aria-label={t`Open files`}
          className="flex shrink-0 overflow-x-auto border-b border-border"
        >
          {tabs.map((file) => (
            <div key={file.path} className="flex shrink-0 items-center border-r border-border">
              <button
                type="button"
                role="tab"
                aria-selected={active === file.path}
                title={file.path}
                className="px-2 py-1 text-xs"
                onClick={() => setActive(file.path)}
              >
                {basename(file.path)}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t`Close ${basename(file.path)}`}
                onClick={() => {
                  const remaining = tabs.filter((item) => item.path !== file.path);
                  setTabs(remaining);
                  if (active === file.path) setActive(remaining.at(-1)?.path ?? "");
                }}
              >
                <X size={12} />
              </Button>
            </div>
          ))}
        </div>
        {current ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1 text-xs text-muted-foreground">
              <span>{current.source === "live" ? t`Live` : t`Saved files`}</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const selection = editor.current?.selection();
                  if (selection) setAsk({ selection, path: current.path });
                }}
              >{t`Ask a bot`}</Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <Suspense fallback={null}>
                <Editor
                  ref={editor}
                  document={{
                    id: current.path,
                    path: current.path,
                    content: current.content,
                    readOnly: true,
                  }}
                  openIds={tabs.map((file) => file.path)}
                  onChange={() => {}}
                  onSave={() => setNotice(t`Read only in this pane. Open IDE to edit.`)}
                  onAsk={() => {
                    const selection = editor.current?.selection();
                    if (selection) setAsk({ selection, path: current.path });
                  }}
                />
              </Suspense>
            </div>
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">{t`Choose a file.`}</p>
        )}
      </div>
      {quick ? (
        <QuickOpen list={list} onOpen={open} onClose={() => setQuick(false)} onError={onError} />
      ) : null}
      {ask ? (
        <AskBot
          bots={[bot]}
          selection={ask.selection}
          path={ask.path}
          onClose={() => setAsk(null)}
          onSend={async (botId, instruction) => {
            await rpc.threads.send({
              botId,
              text: ideHandoffText({
                path: ask.path,
                startLine: ask.selection.startLine,
                endLine: ask.selection.endLine,
                selection: ask.selection.text,
                instruction,
              }),
              clientNonce: crypto.randomUUID(),
            });
          }}
        />
      ) : null}
    </div>
  );
}
