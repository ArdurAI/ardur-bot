import type { McpServer } from "@ardurbot/contracts";
import { DEFAULT_MCP_SERVERS } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { rpc } from "../../lib/rpc";
import { PageError } from "./CustomizeControls";

export function McpDefaults({
  servers,
  onEnabled,
  onBusyChange,
}: {
  servers: McpServer[];
  onEnabled(server: McpServer): Promise<void>;
  onBusyChange?(busy: boolean): void;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [lastAttempt, setLastAttempt] = useState<(() => Promise<void>) | null>(null);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  async function enable(preset: (typeof DEFAULT_MCP_SERVERS)[number], server?: McpServer) {
    setBusy(true);
    setFailed(false);
    setLastAttempt(() => () => enable(preset, server));
    try {
      const enabled = server
        ? server.enabled
          ? server
          : await rpc.mcp.servers.update({ id: server.id, enabled: true })
        : await rpc.mcp.servers.create({
            name: preset.name,
            slug: preset.id,
            transport: "streamable_http",
            endpoint: preset.endpoint,
            headers: {},
            enabled: true,
          });
      setLastAttempt(() => () => enable(preset, enabled));
      await onEnabled(enabled);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={t`Default servers`}>
      <h3 className="text-sm font-medium">{t`Default servers`}</h3>
      {DEFAULT_MCP_SERVERS.map((preset) => {
        const server = servers.find((row) => !row.managedBy && row.endpoint === preset.endpoint);
        return (
          <SettingsRow key={preset.id} label={preset.name} description={preset.endpoint}>
            <Button
              variant="outline"
              size="sm"
              render={<a href={preset.docsUrl} target="_blank" rel="noreferrer" />}
            >{t`Documentation`}</Button>
            <Button size="sm" disabled={busy} onClick={() => void enable(preset, server)}>
              {server?.enabled ? t`Review tools` : t`Enable`}
            </Button>
          </SettingsRow>
        );
      })}
      {failed ? <PageError retry={() => void lastAttempt?.()} /> : null}
    </section>
  );
}
