import type { TerminalSessionCollection } from "@ardurbot/contracts";
import { TERMINAL_SESSION_LIMIT } from "@ardurbot/contracts";
import { addTerminalSession, removeTerminalSession } from "@ardurbot/core";
import { Button, WorkspaceTabs } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import ComputerTerminalSession from "../shell/terminal-session";

export default function TerminalCollection({
  botId,
  computerId,
  visible,
  onCloseLast,
}: {
  botId: string;
  computerId: string;
  visible: boolean;
  onCloseLast(): void | Promise<void>;
}) {
  const { t } = useLingui();
  const [collection, setCollection] = useState<TerminalSessionCollection>(() =>
    addTerminalSession({ sessions: [], activeId: "" }, crypto.randomUUID()),
  );
  const [serverIds, setServerIds] = useState<Record<string, string>>({});
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
        if (window.confirm(t`End this terminal?`)) await onCloseLast();
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
