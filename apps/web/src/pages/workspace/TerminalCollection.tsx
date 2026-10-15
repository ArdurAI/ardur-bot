import type { TerminalSessionCollection } from "@ardurbot/contracts";
import { TERMINAL_SESSION_LIMIT } from "@ardurbot/contracts";
import { addTerminalSession, removeTerminalSession } from "@ardurbot/core";
import { Button, WorkspaceTabs } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import ComputerTerminalSession from "../shell/terminal-session";
import {
  clearTerminalCollection,
  readTerminalCollection,
  writeTerminalCollection,
} from "./terminal-state";

export default function TerminalCollection({
  botId,
  computerId,
  visible,
  onCloseLast,
  storageKey,
  releaseOnDisconnect = false,
}: {
  botId: string;
  computerId: string;
  visible: boolean;
  onCloseLast(): void | Promise<void>;
  storageKey?: string;
  releaseOnDisconnect?: boolean;
}) {
  const { t } = useLingui();
  const [restored] = useState(() => readTerminalCollection(storageKey));
  const [collection, setCollection] = useState<TerminalSessionCollection>(
    () => restored ?? addTerminalSession({ sessions: [], activeId: "" }, crypto.randomUUID()),
  );
  const [serverIds, setServerIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(restored?.sessions.map((session) => [session.id, session.id]) ?? []),
  );
  const initialIds = useRef(new Set(restored?.sessions.map((session) => session.id) ?? []));
  const reloading = useRef(false);
  const snapshot = useRef({ collection, serverIds });
  snapshot.current = { collection, serverIds };
  useEffect(() => {
    writeTerminalCollection(storageKey, collection, serverIds);
  }, [storageKey, collection, serverIds]);
  useEffect(() => {
    const save = () =>
      writeTerminalCollection(storageKey, snapshot.current.collection, snapshot.current.serverIds);
    const hide = () => {
      reloading.current = Boolean(storageKey);
      save();
    };
    const show = () => {
      reloading.current = false;
    };
    const timer = setInterval(save, 5_000);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      if (!reloading.current) clearTerminalCollection(storageKey);
    };
  }, [storageKey]);
  const [pending, setPending] = useState(false);
  const closing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const full = collection.sessions.length >= TERMINAL_SESSION_LIMIT;
  const close = async (id: string) => {
    if (closing.current) return;
    closing.current = true;
    setPending(true);
    setError(null);
    try {
      if (collection.sessions.length === 1) {
        if (window.confirm(t`End this terminal?`)) {
          clearTerminalCollection(storageKey);
          await onCloseLast();
        }
        return;
      }
      if (serverIds[id]) await rpc.terminal.close({ botId, computerId, sessionId: serverIds[id] });
      setCollection((current) => removeTerminalSession(current, id));
      setServerIds((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch {
      setError(t`This action could not finish; try again.`);
    } finally {
      closing.current = false;
      setPending(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={
            full || pending || collection.sessions.some((session) => !serverIds[session.id])
          }
          title={full ? t`Four terminals are already open.` : undefined}
          onClick={() =>
            setCollection((current) =>
              current.sessions.length < TERMINAL_SESSION_LIMIT
                ? addTerminalSession(current, crypto.randomUUID())
                : current,
            )
          }
        >{t`New terminal`}</Button>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <WorkspaceTabs
        mountAll
        label={t`Terminal`}
        value={collection.activeId}
        onChange={(id) => {
          if (collection.sessions.some((session) => session.id === id))
            setCollection((current) => ({ ...current, activeId: id }));
        }}
        onClose={(id) => {
          void close(id);
        }}
        closeLabel={() => t`Close terminal`}
        tabs={collection.sessions.map((session) => {
          const number = session.number;
          return {
            id: session.id,
            label: t`Terminal ${number}`,
            content: (
              <ComputerTerminalSession
                botId={botId}
                computerId={computerId}
                visible={visible && collection.activeId === session.id}
                initialSession={initialIds.current.has(session.id) ? session.id : undefined}
                initialSize={
                  session.cols && session.rows
                    ? { cols: session.cols, rows: session.rows }
                    : undefined
                }
                shouldDetach={() => reloading.current}
                releaseOnDisconnect={releaseOnDisconnect}
                onSize={(size) =>
                  setCollection((current) =>
                    current.sessions.some(
                      (entry) =>
                        entry.id === session.id &&
                        (entry.cols !== size.cols || entry.rows !== size.rows),
                    )
                      ? {
                          ...current,
                          sessions: current.sessions.map((entry) =>
                            entry.id === session.id ? { ...entry, ...size } : entry,
                          ),
                        }
                      : current,
                  )
                }
                onSession={(id) =>
                  setServerIds((current) =>
                    current[session.id] === id ? current : { ...current, [session.id]: id },
                  )
                }
              />
            ),
          };
        })}
      />
    </div>
  );
}
