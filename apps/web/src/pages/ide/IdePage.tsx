import type { Bot, IdeChange, IdeEntry, IdeRoot } from "@ardurbot/contracts";
import { ideHandoffText } from "@ardurbot/contracts";
import { Button, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { rpc } from "../../lib/rpc";
import { WindowChrome } from "../WindowChrome";
import { Changes, useChanges } from "./changes";
import { AskBot, QuickOpen } from "./dialogs";
import type { EditorHandle, EditorSelection } from "./editor";
import Editor from "./editor";
import { FileTree } from "./file-tree";
import type { EditorTab } from "./model";
import { basename, clamp, ideShortcut, modified, readLayout, saveLayout } from "./model";
import { Splitter } from "./splitter";
import { IdeTerminal } from "./terminal";
import { useUnsavedChanges } from "./unsaved";

const SideBySideDiff = lazy(() => import("./diff"));

export default function IdePage() {
  const { t } = useLingui();
  const [roots, setRoots] = useState<IdeRoot[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [rootId, setRootId] = useState("");
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [active, setActive] = useState("");
  const [diff, setDiff] = useState<IdeChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const [ask, setAsk] = useState<{ selection: EditorSelection; path: string } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"terminal" | "changes">("terminal");
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [layout, setLayout] = useState(readLayout);
  const [treeRevision, setTreeRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const root = roots.find((root) => root.id === rootId);
  const tab = tabs.find((tab) => tab.id === active);
  const latest = useRef({ rootId, tabs, tab, saving });
  latest.current = { rootId, tabs, tab, saving };
  const opening = useRef("");
  const rootGeneration = useRef(0);
  const savingRef = useRef(false);
  const requests = useRef(new Map<string, Promise<void>>());
  const directories = useRef(new Map<string, Promise<IdeEntry[]>>());
  const onError = useCallback(
    (error: unknown) =>
      setError(
        error instanceof Error ? error.message : t`This action could not finish; try again.`,
      ),
    [t],
  );
  useUnsavedChanges(tabs.some(modified) || saving, t`Unsaved changes`, saving);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      rpc.ide.roots(undefined, { signal: abort.signal }),
      rpc.bots.list(undefined, { signal: abort.signal }),
    ])
      .then(([roots, bots]) => {
        if (abort.signal.aborted) return;
        setRoots(roots);
        setRootId((current) => current || roots[0]?.id || "");
        setBots(bots);
      })
      .catch((error) => {
        if (!abort.signal.aborted) onError(error);
      });
    return () => abort.abort();
  }, [onError]);
  useEffect(() => saveLayout(layout), [layout]);
  const list = useCallback(
    (path: string) => {
      const key = `${rootId}:${path}`;
      let promise = directories.current.get(key);
      if (!promise) {
        promise = rpc.ide
          .list({ rootId, path })
          .then(({ entries, hiddenCount }) => {
            if (latest.current.rootId === rootId && hiddenCount)
              setStatus(t`Some entries have unsupported names and are hidden (${hiddenCount}).`);
            return entries;
          })
          .catch((error) => {
            directories.current.delete(key);
            throw error;
          });
        directories.current.set(key, promise);
      }
      return promise;
    },
    [rootId, treeRevision, t],
  );
  const open = useCallback(
    (path: string) => {
      const id = `${rootId}:${path}`;
      opening.current = id;
      const generation = rootGeneration.current;
      setDiff(null);
      setStatus(null);
      setError(null);
      if (latest.current.tabs.some((tab) => tab.id === id)) {
        setActive(id);
        return;
      }
      const existing = requests.current.get(id);
      if (existing) return;
      const pending = rpc.ide
        .read({ rootId, path })
        .then((file) => {
          if (latest.current.rootId !== rootId || generation !== rootGeneration.current) return;
          if (file.binary) {
            setError(t`Binary file`);
            return;
          }
          setTabs((tabs) =>
            tabs.some((tab) => tab.id === id)
              ? tabs
              : [...tabs, { ...file, id, savedContent: file.content }],
          );
          if (opening.current === id) setActive(id);
        })
        .catch((error) => {
          if (generation === rootGeneration.current) onError(error);
        })
        .finally(() => {
          if (requests.current.get(id) === pending) requests.current.delete(id);
        });
      requests.current.set(id, pending);
    },
    [rootId, onError, t],
  );
  const save = useCallback(async () => {
    const { tab, rootId } = latest.current;
    if (!tab || tab.readOnly || savingRef.current || !modified(tab)) return;
    savingRef.current = true;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const input = {
        rootId,
        path: tab.path,
        content: tab.content,
        version: tab.version,
        approved: false,
      };
      let result = await rpc.ide.save(input);
      if (latest.current.rootId !== rootId) return;
      if (result.approvalRequired && window.confirm(t`Save`))
        result = await rpc.ide.save({ ...input, approved: true });
      if (!result.saved) {
        if (result.reason) setError(result.reason);
        return;
      }
      setTabs((tabs) =>
        tabs.map((current) =>
          current.id === tab.id
            ? { ...current, savedContent: input.content, version: result.version! }
            : current,
        ),
      );
      setStatus(t`Saved`);
    } catch (error) {
      onError(error);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onError, t]);
  const askBot = useCallback(() => {
    const selection = editor.current?.selection();
    const tab = latest.current.tab;
    if (!selection || !tab || !root) return;
    setAsk({
      selection,
      path:
        root.kind === "host" ? `${root.path.replace(/[/\\]$/, "")}/${tab.path}` : `/${tab.path}`,
    });
  }, [root]);
  const toggleTerminal = useCallback(() => {
    setDrawer((open) => drawerTab !== "terminal" || !open);
    setDrawerTab("terminal");
    setTerminalMounted(true);
  }, [drawerTab]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"]')) return;
      const action = ideShortcut(event);
      if (!action || (action !== "terminal" && target?.closest(".xterm"))) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "save") void save();
      else if (action === "open") setQuick(true);
      else if (action === "find") editor.current?.find();
      else if (action === "ask") askBot();
      else toggleTerminal();
    };
    window.addEventListener("keydown", keyboard, true);
    return () => window.removeEventListener("keydown", keyboard, true);
  }, [save, askBot, toggleTerminal]);
  const filesChanged = useCallback(() => {
    directories.current.clear();
    setTreeRevision((value) => value + 1);
  }, []);
  const changes = useChanges(root?.id, drawer && drawerTab === "changes", onError, filesChanged);
  const close = (closing: EditorTab) => {
    if (savingRef.current) return;
    if (modified(closing) && !window.confirm(t`Unsaved changes`)) return;
    const remaining = tabs.filter((tab) => tab.id !== closing.id);
    setTabs(remaining);
    if (closing.id === active) setActive(remaining.at(-1)?.id ?? "");
  };
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-testid="ide-page"
    >
      <header className="app-drag flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <WindowChrome />
        <Link
          to="/app"
          className="app-no-drag text-sm text-muted-foreground hover:text-foreground"
        >{t`Bots`}</Link>
        <h1 className="text-sm font-medium">{t`IDE`}</h1>
        <div className="app-no-drag ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={!root}
            onClick={() => setQuick(true)}
          >{t`Open`}</Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!tab || tab.readOnly || saving || !modified(tab)}
            onClick={() => void save()}
          >{t`Save`}</Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!tab || !!diff}
            onClick={askBot}
          >{t`Ask a bot`}</Button>
        </div>
      </header>
      {error || status ? (
        <div
          className={`shrink-0 px-3 py-1 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
          role={error ? "alert" : "status"}
        >
          {error ?? status}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="flex min-w-0 flex-col" style={{ width: `${layout.tree}%` }}>
          <div className="border-b border-border p-2">
            <NativeSelect
              aria-label={t`Computer`}
              value={rootId}
              disabled={saving}
              onChange={(event) => {
                if (savingRef.current) return;
                if (tabs.some(modified) && !window.confirm(t`Unsaved changes`)) return;
                opening.current = "";
                rootGeneration.current++;
                requests.current.clear();
                latest.current.rootId = event.target.value;
                setRootId(event.target.value);
                setTabs([]);
                setActive("");
                setDiff(null);
                setAsk(null);
                setError(null);
                setStatus(null);
                directories.current.clear();
              }}
            >
              {!roots.length ? <NativeSelectOption value="">{t`Open`}</NativeSelectOption> : null}
              {roots.map((root) => (
                <NativeSelectOption key={root.id} value={root.id}>
                  {root.kind === "host" ? `${t`This computer`} · ${root.path}` : root.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {root ? (
            <FileTree
              key={root.id}
              list={list}
              onOpen={open}
              onError={onError}
              selected={tab?.path}
            />
          ) : null}
        </aside>
        <Splitter
          label={t`IDE`}
          value={layout.tree}
          onChange={(tree) =>
            setLayout((current) => ({ ...current, tree: clamp(tree, 15, 40, 22) }))
          }
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label={t`IDE`}
            className="flex h-10 shrink-0 overflow-x-auto border-b border-border"
          >
            {tabs.map((current) => (
              <div
                key={current.id}
                className={`flex shrink-0 items-center border-r border-border ${current.id === active && !diff ? "bg-muted" : ""}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={current.id === active && !diff}
                  title={current.path}
                  className="px-3 py-2 text-xs"
                  onClick={() => {
                    setActive(current.id);
                    setDiff(null);
                  }}
                >
                  {basename(current.path)}
                  {modified(current) ? (
                    <span role="img" aria-label={t`Unsaved changes`}>
                      {" "}
                      ●
                    </span>
                  ) : null}
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t`Close ${basename(current.path)}`}
                  disabled={saving}
                  onClick={() => close(current)}
                >
                  <X size={12} />
                </Button>
              </div>
            ))}
            {diff ? (
              <button
                type="button"
                role="tab"
                aria-selected
                className="px-3 text-xs"
                onClick={() => setDiff(null)}
              >
                {diff.path} · {t`Changes`}
              </button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {diff ? (
              <Suspense fallback={null}>
                <SideBySideDiff change={diff} />
              </Suspense>
            ) : tab ? (
              <div className="flex h-full flex-col">
                {tab.readOnly ? (
                  <p
                    role="status"
                    className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
                  >{t`Read only: file is larger than 2 MB`}</p>
                ) : null}
                <div className="min-h-0 flex-1">
                  <Editor
                    ref={editor}
                    document={tab}
                    openIds={tabs.map((tab) => tab.id)}
                    onChange={(id, content) => {
                      setTabs((tabs) =>
                        tabs.map((tab) => (tab.id === id ? { ...tab, content } : tab)),
                      );
                      setStatus(null);
                    }}
                    onSave={() => void save()}
                    onAsk={askBot}
                  />
                </div>
              </div>
            ) : null}
          </div>
          {drawer ? (
            <Splitter
              horizontal
              label={t`Terminal`}
              value={layout.drawer}
              onChange={(drawer) =>
                setLayout((current) => ({ ...current, drawer: clamp(drawer, 15, 65, 30) }))
              }
            />
          ) : null}
          <div
            className="flex h-9 shrink-0 items-center gap-1 border-t border-border px-2"
            role="tablist"
            aria-label={t`Terminal`}
          >
            <Button
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={drawer && drawerTab === "terminal"}
              onClick={() => {
                setDrawer(drawerTab !== "terminal" || !drawer);
                setDrawerTab("terminal");
                setTerminalMounted(true);
              }}
            >{t`Terminal`}</Button>
            <Button
              variant="ghost"
              size="sm"
              role="tab"
              aria-selected={drawer && drawerTab === "changes"}
              onClick={() => {
                setDrawer(drawerTab !== "changes" || !drawer);
                setDrawerTab("changes");
              }}
            >{t`Changes`}</Button>
          </div>
          <div
            className={drawer ? "min-h-0 shrink-0 overflow-hidden" : "hidden"}
            style={{ height: `${layout.drawer}%` }}
          >
            <div className={drawerTab === "terminal" ? "h-full" : "hidden"}>
              {terminalMounted && root ? <IdeTerminal key={root.id} root={root} /> : null}
            </div>
            <div className={drawerTab === "changes" ? "h-full" : "hidden"}>
              <Changes
                items={changes.items}
                more={changes.more}
                onOpen={setDiff}
                onError={onError}
              />
            </div>
          </div>
        </main>
      </div>
      {quick && root ? (
        <QuickOpen list={list} onOpen={open} onClose={() => setQuick(false)} onError={onError} />
      ) : null}
      {ask ? (
        <AskBot
          bots={bots}
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
