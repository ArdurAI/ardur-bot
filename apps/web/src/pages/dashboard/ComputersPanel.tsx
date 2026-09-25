import type { ComputerStatus } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { rpc } from "../../lib/rpc";
import type { PanelActions, PanelContext } from "./panels";

export async function load(context: PanelContext) {
  const options = { signal: context.signal, context: { spaceId: context.spaceId } };
  const [host, computers, connections, local] = await Promise.all([
    rpc.host.status({}, options),
    rpc.computer.list(undefined, options),
    rpc.computer.connections(undefined, options),
    window.ardurbotDesktop?.host?.state(),
  ]);
  return {
    host: { ...host, roots: local?.configured ? local.roots : host.roots },
    computers,
    engines: connections,
  };
}
export default function ComputersPanel({
  data,
  openSettings,
}: { data: Awaited<ReturnType<typeof load>> } & PanelActions) {
  const { t } = useLingui();
  const states: Record<ComputerStatus["state"], string> = {
    stopped: t`Stopped`,
    booting: t`Booting`,
    running: t`Running`,
    suspended: t`Asleep`,
    error: t`Error`,
  };
  const count = data.host.roots.length;
  const seen = new Set<string>();
  return (
    <div className="space-y-2 text-sm">
      <Button
        variant="ghost"
        className="h-auto w-full justify-between whitespace-normal text-start"
        onClick={() => openSettings("computer")}
      >
        <span>
          <Trans>This computer</Trans>
        </span>
        <span className="text-muted-foreground">
          {data.host.connected ? t`Connected` : t`Not connected`}
          {" · "}
          {t`${count} folders`}
        </span>
      </Button>
      {data.computers
        .filter((computer) => {
          const id = computer.status.computerId ?? computer.botId;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .map((computer) => (
          <Button
            key={computer.status.computerId ?? computer.botId}
            variant="ghost"
            className="h-auto w-full justify-between whitespace-normal text-start"
            onClick={() => openSettings("computer")}
          >
            <span>{computer.name}</span>
            <span className="text-muted-foreground">{states[computer.status.state]}</span>
          </Button>
        ))}
      {data.engines.map((engine) => (
        <Button
          key={engine.id}
          variant="ghost"
          className="h-auto w-full justify-between whitespace-normal text-start"
          onClick={() => openSettings("computer")}
        >
          <span>{engine.name}</span>
          <span className="text-muted-foreground">
            {engine.status === "connected"
              ? t`Connected`
              : engine.status === "error"
                ? t`Error`
                : t`Not connected`}
          </span>
        </Button>
      ))}
    </div>
  );
}
