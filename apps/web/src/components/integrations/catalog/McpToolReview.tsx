import type {
  Bot,
  BotMcpServer,
  IntegrationManifest,
  McpServer,
  SpaceToolPolicies,
} from "@ardurbot/contracts";
import { Button, Checkbox, Dialog, DialogContent, DialogTitle } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { ToolPermissions } from "../manage/ToolPermissions";

/** Existing custom servers use the same explicit picker, without a trusted catalog policy. */
export function McpToolReview({
  server,
  bots,
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
  const [overrides, setOverrides] = useState<
    Array<{ botId: string; access: "inherit" | "custom" | "none"; toolIds: string[] }>
  >([]);
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [spaceToolPolicies, setSpaceToolPolicies] = useState<SpaceToolPolicies>(
    server.spaceToolPolicies ?? {},
  );
  const [savedPolicies, setSavedPolicies] = useState<SpaceToolPolicies>(
    server.spaceToolPolicies ?? {},
  );
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setError(false);
    setManifest(null);
    try {
      const manifest = await rpc.mcp.servers.tools({ serverId: server.id });
      const current = (await rpc.mcp.assignments.all()).filter(
        (entry) => entry.serverId === server.id,
      );
      setOverrides(
        current.map((entry) => ({
          botId: entry.botId,
          access: entry.access,
          toolIds: entry.allowedTools,
        })),
      );
      const latest = (await rpc.mcp.servers.list()).find((entry) => entry.id === server.id);
      setToolIds(latest?.spaceAllowedTools ?? []);
      setSpaceToolPolicies(latest?.spaceToolPolicies ?? {});
      setSavedPolicies(latest?.spaceToolPolicies ?? {});
      setManifest(manifest);
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
      await rpc.mcp.servers.permissions({
        serverId: server.id,
        overrides: overrides.map((entry) => ({
          ...entry,
          toolIds:
            entry.access === "custom" ? entry.toolIds.filter((id) => toolIds.includes(id)) : [],
        })),
        toolIds,
        ...(JSON.stringify(spaceToolPolicies) === JSON.stringify(savedPolicies)
          ? {}
          : { spaceToolPolicies }),
      });
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
          <p className="text-sm text-muted-foreground">
            {server.transport === "host-cli"
              ? t`All desktop bots have access (including ones you create later).`
              : t`All bots have access (bots you create later too).`}
          </p>
          {bots.map((bot) => {
            const override = overrides.find((entry) => entry.botId === bot.id);
            const removed = override?.access === "none";
            return (
              <div key={bot.id} className="space-y-2">
                <label
                  htmlFor={`${controlId}-${bot.id}`}
                  className="flex items-center gap-3 text-sm"
                >
                  <Checkbox
                    id={`${controlId}-${bot.id}`}
                    checked={!removed}
                    onCheckedChange={(checked) =>
                      setOverrides((current) => [
                        ...current.filter((entry) => entry.botId !== bot.id),
                        { botId: bot.id, access: checked ? "inherit" : "none", toolIds: [] },
                      ])
                    }
                  />
                  {bot.name}
                  {removed ? <span className="text-muted-foreground">{t`Removed`}</span> : null}
                </label>
                {!removed && manifest ? (
                  <details className="ml-7 text-sm">
                    <summary className="cursor-pointer">{t`Limit tools`}</summary>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setOverrides((current) => [
                          ...current.filter((entry) => entry.botId !== bot.id),
                          { botId: bot.id, access: "inherit", toolIds: [] },
                        ])
                      }
                    >{t`Use all selected tools`}</Button>
                    {manifest.tools
                      .filter((tool) => toolIds.includes(tool.id))
                      .map((tool) => (
                        <div key={tool.id} className="flex items-center gap-2">
                          <Checkbox
                            aria-label={`${bot.name}: ${tool.id}`}
                            checked={
                              override?.access !== "custom" || override.toolIds.includes(tool.id)
                            }
                            onCheckedChange={(checked) => {
                              const currentTools =
                                override?.access === "custom" ? override.toolIds : toolIds;
                              setOverrides((current) => [
                                ...current.filter((entry) => entry.botId !== bot.id),
                                {
                                  botId: bot.id,
                                  access: "custom",
                                  toolIds: checked
                                    ? [...new Set([...currentTools, tool.id])]
                                    : currentTools.filter((id) => id !== tool.id),
                                },
                              ]);
                            }}
                          />
                          {tool.id}
                        </div>
                      ))}
                  </details>
                ) : null}
              </div>
            );
          })}
        </fieldset>
        {manifest ? (
          <ToolPermissions
            manifest={manifest}
            selected={toolIds}
            onChange={setToolIds}
            disabled={busy}
            spaceToolPolicies={spaceToolPolicies}
            onPolicyChange={setSpaceToolPolicies}
          />
        ) : null}
        <Button disabled={busy || !manifest} onClick={() => void save()}>{t`Save`}</Button>
      </DialogContent>
    </Dialog>
  );
}
