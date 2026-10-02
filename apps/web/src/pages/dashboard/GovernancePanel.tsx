import type { SpaceFeatureEntry } from "@ardurbot/contracts";
import { Switch } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import governanceDoc from "../../../../../docs/governance.md?url";
import { rpc } from "../../lib/rpc";
import type { PanelContext } from "./panels";

export async function load(context: PanelContext) {
  const features = await rpc.features.list(undefined, {
    signal: context.signal,
    context: { spaceId: context.spaceId },
  });
  const governance = features.find((entry) => entry.feature === "governance");
  if (!governance) throw new Error("Missing governance availability");
  return { ...governance, spaceId: context.spaceId };
}
export default function GovernancePanel({
  data,
}: {
  data: SpaceFeatureEntry & { spaceId: string };
}) {
  const { t } = useLingui();
  const [enabled, setEnabled] = useState(data.state === "enabled");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setEnabled(data.state === "enabled"), [data.state]);
  async function toggle(checked: boolean) {
    if (!data.canManage || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await rpc.features.set(
        { feature: "governance", state: checked ? "enabled" : "disabled" },
        { context: { spaceId: data.spaceId } },
      );
      // Read the authoritative state after the write, rather than trusting a local toggle.
      const features = await rpc.features.list(undefined, { context: { spaceId: data.spaceId } });
      setEnabled(features.find((feature) => feature.feature === "governance")?.state === "enabled");
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      {data.canManage ? (
        <label className="flex items-center justify-between gap-3" htmlFor="record-evidence">
          <Trans>Record evidence of bot decisions</Trans>
          <Switch
            id="record-evidence"
            aria-label={t`Record evidence of bot decisions`}
            checked={enabled}
            disabled={saving}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </label>
      ) : (
        <p className="text-muted-foreground">
          {enabled ? <Trans>Evidence on</Trans> : <Trans>Evidence off</Trans>}
        </p>
      )}
      <a
        className="text-muted-foreground underline underline-offset-4"
        href={governanceDoc}
        target="_blank"
        rel="noreferrer"
      >
        <Trans>About evidence</Trans>
      </a>
      {failed ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not save. Try again.</Trans>
        </p>
      ) : null}
    </div>
  );
}
