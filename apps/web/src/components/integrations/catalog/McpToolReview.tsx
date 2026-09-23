import type { Bot, BotMcpServer, IntegrationManifest, McpServer } from "@ardurbot/contracts";
import { Button, Checkbox, Dialog, DialogContent, DialogTitle } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { ToolPicker } from "./ToolPicker";

/** Existing custom servers use the same explicit picker, without a trusted catalog policy. */
export function McpToolReview({
  server,
  bots,
  assignments,
  onClose,
  onSaved,
}: {
  server: McpServer;
  bots: Bot[];
  assignments: Record<string, BotMcpServer[]>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLingui();
  const controlId = useId();
  const [manifest, setManifest] = useState<IntegrationManifest | null>(null);
  const [botIds, setBotIds] = useState(() =>
    bots
      .filter((bot) => assignments[bot.id]?.some((entry) => entry.serverId === server.id))
      .map((bot) => bot.id),
  );
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setError(false);
    try {
      setManifest(await rpc.mcp.servers.tools({ serverId: server.id }));
    } catch {
      setError(true);
    }
  };
  useEffect(() => {
    void load();
  }, [server.id]);
  async function save() {
    setBusy(true);
    setError(false);
    try {
      for (const bot of bots) {
        const current = (assignments[bot.id] ?? []).filter((entry) => entry.serverId !== server.id);
        await rpc.mcp.assignments.replace({
          botId: bot.id,
          assignments: [
            ...current,
            ...(botIds.includes(bot.id)
              ? [
                  {
                    serverId: server.id,
                    allowAllTools: false,
                    needsReview: false,
                    allowedTools: toolIds,
                  },
                ]
              : []),
          ],
        });
      }
      await onSaved();
      onClose();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogTitle>{t`Review tools`}</DialogTitle>
        {error ? (
          <div role="alert">
            <p>{t`Could not load or save tools.`}</p>
            <Button onClick={() => void load()}>{t`Try again`}</Button>
          </div>
        ) : null}
        <fieldset disabled={busy} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{t`Bots`}</legend>
          {bots.map((bot) => (
            <label
              key={bot.id}
              htmlFor={`${controlId}-${bot.id}`}
              className="flex items-center gap-3 text-sm"
            >
              <Checkbox
                id={`${controlId}-${bot.id}`}
                checked={botIds.includes(bot.id)}
                onCheckedChange={(checked) =>
                  setBotIds(checked ? [...botIds, bot.id] : botIds.filter((id) => id !== bot.id))
                }
              />
              {bot.name}
            </label>
          ))}
        </fieldset>
        {manifest ? (
          <ToolPicker
            manifest={manifest}
            selected={toolIds}
            onChange={setToolIds}
            disabled={busy}
          />
        ) : null}
        <Button disabled={busy || !manifest} onClick={() => void save()}>{t`Save`}</Button>
      </DialogContent>
    </Dialog>
  );
}
