import type { Bot, IdeEntry, WorkspaceContext } from "@ardurbot/contracts";
import { ideHandoffText } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { createElement, lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { actionMessage } from "../../lib/orpc-action-message";
import { rpc } from "../../lib/rpc";
import { AskBot, QuickOpen } from "./dialogs";
import type { EditorHandle, EditorSelection } from "./editor";
import {
  readWorkspaceFileSession,
  setWorkspaceFileSaving,
  type WorkspaceFileSession,
  type WorkspaceOpenFile,
  workspaceFileSessionId,
  writeWorkspaceFileSession,
} from "./file-sessions";
import { FileTree } from "./file-tree";
import { basename } from "./files-model";

const Editor = lazy(() => import("./editor"));
const emptySession: WorkspaceFileSession = { tabs: [], active: "" };
const fileChangedReason = "The file changed. Open it again before saving.";

/** The message is the only text node. Formatting would otherwise wrap space around it. */
function exactNotice(role: "alert" | "status", className: string, text: string) {
  return createElement("p", { role, className }, text);
}

export function WorkspaceFiles({
  bot,
  context,
  compact = false,
}: {
  bot: Bot;
  context: WorkspaceContext;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const computerId = context.computerId;
  const generation = context.generation;
  const valid = Boolean(computerId) && generation !== null && context.files !== "unavailable";
  const sessionId = valid ? workspaceFileSessionId(bot.id, computerId!) : null;
  const describeSaveError = (reason: string) => {
    switch (reason) {
      case fileChangedReason:
        return t`The file changed. Open it again before saving.`;
      case "The computer is busy. Wait for it to finish.":
        return t`The computer is busy. Wait for it to finish.`;
      case "Computer changed. Refresh files.":
        return t`Computer changed. Refresh files.`;
      case "Files are unavailable on this computer.":
        return t`Files are unavailable on this computer.`;
      case "This is a binary file. You cannot edit it here.":
        return t`This is a binary file. You cannot edit it here.`;
      case "This file is read-only. Open a copy to edit it.":
        return t`This file is read-only. Open a copy to edit it.`;
      case "This file is larger than 2 MB. Open a copy to edit it.":
        return t`This file is larger than 2 MB. Open a copy to edit it.`;
      case "This file no longer exists. Save it as a new file or close it.":
        return t`This file no longer exists. Save it as a new file or close it.`;
      default:
        return t`Could not save this file. Try again.`;
    }
  };
  const [boundId, setBoundId] = useState<string | null>(sessionId);
  const [session, setSession] = useState<WorkspaceFileSession>(() =>
    sessionId ? readWorkspaceFileSession(sessionId) : emptySession,
  );
  const [quick, setQuick] = useState(false);
  const [treeExpanded, setTreeExpanded] = useState(false);
  const [ask, setAsk] = useState<{ selection: EditorSelection; path: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);
  if (sessionId !== boundId) {
    if (boundId) writeWorkspaceFileSession(boundId, session, false);
    setBoundId(sessionId);
    setSession(sessionId ? readWorkspaceFileSession(sessionId) : emptySession);
  }
  const showing =
    sessionId === boundId
      ? session
      : sessionId
        ? readWorkspaceFileSession(sessionId)
        : emptySession;
  const sessionRef = useRef(showing);
  const boundRef = useRef(sessionId);
  sessionRef.current = showing;
  boundRef.current = sessionId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (boundRef.current) writeWorkspaceFileSession(boundRef.current, sessionRef.current);
    };
  }, []);
  const commit = (next: WorkspaceFileSession) => {
    sessionRef.current = next;
    setSession(next);
    if (sessionId) writeWorkspaceFileSession(sessionId, next);
  };
  const list = useCallback(
    async (path: string): Promise<IdeEntry[]> => {
      if (!computerId || generation === null) return [];
      const result = await rpc.workspace.list({
        botId: bot.id,
        computerId,
        generation,
        path,
      });
      return result.entries;
    },
    [bot.id, computerId, generation, revision],
  );
  const open = (path: string) => {
    const target = sessionId;
    if (!target || !computerId || generation === null) return;
    const existing = sessionRef.current.tabs.find((tab) => tab.path === path);
    if (existing && !existing.conflict) {
      commit({ ...sessionRef.current, active: existing.id });
      setError(null);
      return;
    }
    setError(null);
    setStatus(null);
    void rpc.workspace
      .read({ botId: bot.id, computerId, generation, path })
      .then((file) => {
        if (file.binary) {
          if (alive.current && boundRef.current === target) {
            setError(t`This is a binary file. You cannot edit it here.`);
            setStatus(null);
          }
          return;
        }
        const stored = readWorkspaceFileSession(target);
        const previous = stored.tabs.find((tab) => tab.path === path);
        if (previous && !previous.conflict) {
          const next = { ...stored, active: previous.id };
          writeWorkspaceFileSession(target, next);
          if (alive.current && boundRef.current === target) setSession(next);
          return;
        }
        // A new id is what makes the editor show the reloaded text.
        const id = previous ? `${target}/${path}#${file.version}` : `${target}/${path}`;
        const tab: WorkspaceOpenFile = {
          ...file,
          id,
          savedContent: file.content,
          readOnly: file.readOnly === true,
          source: file.context.files === "live" ? "live" : "saved",
        };
        const next = previous
          ? {
              tabs: stored.tabs.map((item) => (item.path === path ? tab : item)),
              active: id,
            }
          : { tabs: [...stored.tabs, tab], active: id };
        writeWorkspaceFileSession(target, next);
        if (alive.current && boundRef.current === target) {
          setSession(next);
          setError(null);
        }
      })
      .catch(() => {
        if (alive.current && boundRef.current === target)
          setError(t`Could not load files. Try again.`);
      });
  };
  const save = async () => {
    const target = sessionId;
    const tab = sessionRef.current.tabs.find((item) => item.id === sessionRef.current.active);
    if (
      !target ||
      !computerId ||
      generation === null ||
      !tab ||
      tab.readOnly ||
      savingRef.current ||
      tab.content === tab.savedContent
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setWorkspaceFileSaving(true);
    setStatus(null);
    setError(null);
    try {
      const input = {
        botId: bot.id,
        computerId,
        generation,
        path: tab.path,
        content: tab.content,
        version: tab.version,
        approved: false,
      };
      let result = await rpc.workspace.save(input);
      if (result.approvalRequired && window.confirm(t`Save`))
        result = await rpc.workspace.save({ ...input, approved: true });
      if (!result.saved) {
        if (result.reason && alive.current && boundRef.current === target) {
          const current = sessionRef.current;
          const next =
            result.reason === fileChangedReason
              ? {
                  ...current,
                  tabs: current.tabs.map((item) =>
                    item.id === tab.id ? { ...item, conflict: true } : item,
                  ),
                }
              : current;
          if (next !== current) {
            sessionRef.current = next;
            writeWorkspaceFileSession(target, next);
            setSession(next);
          }
          setError(describeSaveError(result.reason));
        }
        return;
      }
      const stored = readWorkspaceFileSession(target);
      const next = {
        ...stored,
        tabs: stored.tabs.map((item) =>
          item.id === tab.id
            ? { ...item, savedContent: input.content, version: result.version ?? item.version }
            : item,
        ),
      };
      writeWorkspaceFileSession(target, next);
      if (alive.current && boundRef.current === target) {
        setSession(next);
        setStatus(t`Saved`);
      }
    } catch (error) {
      if (alive.current && boundRef.current === target)
        setError(describeSaveError(actionMessage(error, "")));
    } finally {
      savingRef.current = false;
      setWorkspaceFileSaving(false);
      if (alive.current) setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;
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
        event.preventDefault();
        editor.current?.find();
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", hotkey, true);
    return () => window.removeEventListener("keydown", hotkey, true);
  }, []);
  const current = showing.tabs.find((tab) => tab.id === showing.active);
  const close = (tab: WorkspaceOpenFile) => {
    if (savingRef.current) return;
    if (tab.content !== tab.savedContent && !window.confirm(t`Unsaved changes`)) return;
    const remaining = sessionRef.current.tabs.filter((item) => item.id !== tab.id);
    commit({
      tabs: remaining,
      active:
        tab.id === sessionRef.current.active
          ? (remaining.at(-1)?.id ?? "")
          : sessionRef.current.active,
    });
  };
  if (!valid || !computerId || generation === null)
    return (
      <p className="p-4 text-sm text-muted-foreground">{t`Files are unavailable on this computer.`}</p>
    );
  return (
    <div data-workspace-files className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1 text-xs text-muted-foreground">
        <span>{context.files === "live" ? t`Live files` : t`Saved files`}</span>
        <div className="flex gap-1">
          <Button variant="ghost" size="xs" onClick={() => setQuick(true)}>{t`Quick open`}</Button>
          <Button variant="ghost" size="xs" onClick={() => setRevision((value) => value + 1)}>
            {t`Refresh`}
          </Button>
        </div>
      </div>
      {error
        ? exactNotice("alert", "px-2 py-1 text-xs text-destructive", error)
        : status
          ? exactNotice("status", "px-2 py-1 text-xs text-muted-foreground", status)
          : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {compact && current ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={treeExpanded}
            onClick={() => setTreeExpanded((value) => !value)}
          >{t`Files`}</Button>
        ) : null}
        <div
          hidden={compact && !!current && !treeExpanded}
          className="h-40 shrink-0 overflow-auto border-b border-border"
        >
          <FileTree
            key={`${computerId}:${revision}`}
            label={t`Files`}
            list={list}
            onOpen={open}
            onError={() => setError(t`Could not load files. Try again.`)}
            selected={current?.path}
          />
        </div>
        <div
          role="tablist"
          aria-label={t`Open files`}
          className="flex shrink-0 overflow-x-auto border-b border-border"
        >
          {showing.tabs.map((file) => (
            <div key={file.id} className="flex shrink-0 items-center border-r border-border">
              <button
                type="button"
                role="tab"
                aria-selected={showing.active === file.id}
                title={file.path}
                className="px-2 py-1 text-xs"
                onClick={() => commit({ ...sessionRef.current, active: file.id })}
              >
                {basename(file.path)}
                {file.content !== file.savedContent ? (
                  <span role="img" aria-label={t`Unsaved changes`}>
                    {" "}
                    ●
                  </span>
                ) : null}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t`Close ${basename(file.path)}`}
                onClick={() => close(file)}
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
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={current.readOnly || saving || current.content === current.savedContent}
                  onClick={() => void save()}
                >{t`Save`}</Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    const selection = editor.current?.selection();
                    if (selection) setAsk({ selection, path: current.path });
                  }}
                >{t`Ask a bot`}</Button>
              </div>
            </div>
            {current.readOnly ? (
              <p
                role="status"
                className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
              >
                {t`This file is larger than 2 MB. Open a copy to edit it.`}
              </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden">
              <Suspense fallback={null}>
                <Editor
                  ref={editor}
                  document={{
                    id: current.id,
                    path: current.path,
                    content: current.content,
                    readOnly: current.readOnly === true,
                  }}
                  openIds={showing.tabs.map((tab) => tab.id)}
                  onChange={(id, content) => {
                    commit({
                      ...sessionRef.current,
                      tabs: sessionRef.current.tabs.map((tab) =>
                        tab.id === id ? { ...tab, content } : tab,
                      ),
                    });
                    setStatus(null);
                  }}
                  onSave={() => void save()}
                  onAsk={() => {
                    const selection = editor.current?.selection();
                    if (selection && current) setAsk({ selection, path: current.path });
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
        <QuickOpen
          list={list}
          onOpen={open}
          onClose={() => setQuick(false)}
          onError={() => setError(t`Could not load files. Try again.`)}
        />
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
