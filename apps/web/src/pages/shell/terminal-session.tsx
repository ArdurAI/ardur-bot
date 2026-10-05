import Terminal from "@ardurbot/ui-web/terminal";
import { t } from "@lingui/core/macro";
import { rpc } from "../../lib/rpc";

export default function ComputerTerminalSession({
  botId,
  computerId,
  workspace,
  visible = true,
}: {
  botId: string;
  computerId: string;
  workspace?: "computer";
  visible?: boolean;
}) {
  return (
    <Terminal
      visible={visible}
      openLink={(url) => {
        window.open(url, "_blank", "noopener,noreferrer");
      }}
      key={`${computerId}:${botId}`}
      close={(sessionId) => rpc.terminal.close({ botId, computerId, sessionId })}
      ticket={(sessionId) => rpc.terminal.ticket({ botId, computerId, sessionId, workspace })}
      labels={{
        terminal: t`Terminal`,
        openLink: t`Open link`,
        reconnect: t`Reconnect`,
        opening: t`Opening terminal`,
        connecting: t`Connection lost — reconnecting`,
        ended: t`Session ended — open a new terminal`,
        newSession: t`Open a new terminal`,
        find: t`Find in terminal`,
        previous: t`Previous`,
        next: t`Next`,
      }}
    />
  );
}
