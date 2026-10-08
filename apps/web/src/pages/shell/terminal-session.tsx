import Terminal from "@ardurbot/ui-web/terminal";
import { t } from "@lingui/core/macro";
import { rpc } from "../../lib/rpc";

export default function ComputerTerminalSession({
  botId,
  computerId,
  workspace,
  visible = true,
  onSession,
  initialSession,
  initialSize,
  shouldDetach,
  onSize,
  releaseOnDisconnect,
}: {
  botId: string;
  computerId: string;
  workspace?: "computer";
  visible?: boolean;
  onSession?(id: string): void;
  initialSession?: string;
  initialSize?: { cols: number; rows: number };
  shouldDetach?(): boolean;
  onSize?(size: { cols: number; rows: number }): void;
  releaseOnDisconnect?: boolean;
}) {
  return (
    <Terminal
      visible={visible}
      onSession={onSession}
      initialSession={initialSession}
      initialSize={initialSize}
      shouldDetach={shouldDetach}
      onSize={onSize}
      openLink={(url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      }}
      key={`${computerId}:${botId}`}
      close={(sessionId) => rpc.terminal.close({ botId, computerId, sessionId })}
      ticket={(sessionId) =>
        rpc.terminal.ticket({ botId, computerId, sessionId, workspace, releaseOnDisconnect })
      }
      labels={{
        terminal: t`Terminal`,
        openLink: t`Open link`,
        reconnect: t`Reconnect`,
        opening: t`Opening terminal`,
        connecting: t`Reconnecting terminal`,
        expired: t`Terminal expired`,
        earlierUnavailable: t`Earlier output is unavailable`,
        ended: t`Session ended — open a new terminal`,
        newSession: t`Open a new terminal`,
        find: t`Find in terminal`,
        previous: t`Previous`,
        next: t`Next`,
      }}
    />
  );
}
