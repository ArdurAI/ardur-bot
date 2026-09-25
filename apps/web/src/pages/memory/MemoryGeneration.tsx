import type { SpaceLearningConfig } from "@ardurbot/contracts";
import { Switch } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { rpc, selectedSpaceId } from "../../lib/rpc";

export function MemoryGeneration({
  settings,
  onChange,
}: {
  settings: SpaceLearningConfig;
  onChange: (settings: SpaceLearningConfig) => void;
}) {
  const { t } = useLingui();
  const spaceId = selectedSpaceId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const locked = useRef(false);

  async function change(enabled: boolean) {
    if (locked.current || !settings.canConfigure) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      onChange(
        await rpc.learning.configure(
          {
            enabled,
            reviewerPin: settings.reviewerPin ?? settings.destination,
            consolidationEnabled: settings.consolidationEnabled,
            budgets: settings.budgets,
          },
          { context: { spaceId } },
        ),
      );
      window.dispatchEvent(new Event("learning-changed"));
    } catch {
      setError(true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 py-4">
      <SettingsRow
        label={t`Generate memory from chats`}
        content={
          <>
            {!settings.enabled && settings.destination ? (
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Review model: {settings.destination.modelId}. Model usage may incur charges.
                </Trans>
              </p>
            ) : null}
            {!settings.enabled && !settings.destination ? (
              <p className="text-sm text-muted-foreground">
                <Trans>Choose a model in Models to enable memory suggestions.</Trans>
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                <Trans>Could not change memory generation. Try again.</Trans>
              </p>
            ) : null}
          </>
        }
      >
        <Switch
          aria-label={t`Generate memory from chats`}
          checked={settings.enabled}
          disabled={!settings.canConfigure || busy || (!settings.enabled && !settings.destination)}
          onCheckedChange={(enabled) => void change(enabled)}
        />
      </SettingsRow>
    </div>
  );
}
