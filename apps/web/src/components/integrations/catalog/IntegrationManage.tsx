import type {
  Bot,
  IntegrationConnection,
  IntegrationDescriptor,
  IntegrationGrant,
} from "@ardurbot/contracts";
import { Button, Checkbox } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../../lib/rpc";
import { ToolPicker } from "./ToolPicker";

export function IntegrationManage({
  descriptor,
  connection,
  onBack,
  onChanged,
}: {
  descriptor: IntegrationDescriptor;
  connection: IntegrationConnection;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const controlId = useId();
  const [bots, setBots] = useState<Bot[]>([]);
  const [grants, setGrants] = useState<IntegrationGrant[]>([]);
  const [botIds, setBotIds] = useState<string[]>([]);
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const load = async () => {
    setError(false);
    setLoading(true);
    try {
      const [bots, grants] = await Promise.all([
        rpc.bots.list(),
        rpc.integrations.grants({ connectionId: connection.id }),
      ]);
      setBots(bots.filter((bot) => !bot.archivedAt));
      setGrants(grants);
      setBotIds(grants.map((grant) => grant.botId));
      // A shared editor must never silently broaden different bots' grants.
      setToolIds(
        grants[0]?.toolIds.filter((id) => grants.every((grant) => grant.toolIds.includes(id))) ??
          [],
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [connection.id]);

  async function save() {
    setBusy(true);
    setError(false);
    try {
      const updated = await rpc.integrations.assign({
        connectionId: connection.id,
        botIds,
        toolIds,
      });
      setGrants(updated);
      setSaved(true);
      await onChanged();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    setBusy(true);
    setError(false);
    try {
      await rpc.integrations.revoke({ connectionId: connection.id });
      await onChanged();
      onBack();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5" data-testid="integration-manage">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{descriptor.name}</h2>
        <Button variant="ghost" disabled={busy} onClick={onBack}>{t`Back`}</Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t`Account`}</dt>
        <dd>{connection.manifest?.account ?? t`Account details are unavailable.`}</dd>
        <dt className="text-muted-foreground">{t`Runs on`}</dt>
        <dd>{descriptor.placement === "backend" ? t`Server` : t`Computer`}</dd>
      </dl>
      <a
        href={descriptor.docsUrl}
        target="_blank"
        rel="noreferrer"
        className="text-sm underline underline-offset-4"
      >{t`Documentation`}</a>
      {error ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{t`Could not save or load access.`}</p>
          <Button variant="outline" onClick={() => void load()}>{t`Try again`}</Button>
        </div>
      ) : null}
      {loading ? (
        <p className="text-sm text-muted-foreground">{t`Loading your tools.`}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {saved
              ? t`Your bots can use the selected tools.`
              : connection.needsReview || grants.some((grant) => grant.needsReview)
                ? t`Review tools before your bots can use this account.`
                : t`Choose bots and the tools they can use.`}
          </p>
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
                  aria-label={bot.name}
                  checked={botIds.includes(bot.id)}
                  onCheckedChange={(checked) => {
                    setSaved(false);
                    setBotIds(checked ? [...botIds, bot.id] : botIds.filter((id) => id !== bot.id));
                  }}
                />
                {bot.name}
              </label>
            ))}
          </fieldset>
          {connection.manifest ? (
            <ToolPicker
              descriptor={descriptor}
              manifest={connection.manifest}
              selected={toolIds}
              disabled={busy}
              onChange={(ids) => {
                setSaved(false);
                setToolIds(ids);
              }}
            />
          ) : null}
          <div className="flex gap-2">
            <Button disabled={busy || connection.state !== "connected"} onClick={() => void save()}>
              {connection.needsReview ? t`Review tools` : t`Save`}
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void revoke()}
            >{t`Disconnect`}</Button>
          </div>
        </>
      )}
    </div>
  );
}
