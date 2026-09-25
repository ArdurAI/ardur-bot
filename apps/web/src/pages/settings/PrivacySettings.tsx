import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { downloadArtifactBytes } from "../../lib/artifact-open";
import { rpc } from "../../lib/rpc";
import type { SettingsPageProps } from "../settings-types";
import { UploadedFiles } from "./UploadedFiles";

export default function PrivacySettings({ navigate, onBusyChange }: SettingsPageProps) {
  const { t } = useLingui();
  const [filesOpen, setFilesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  async function download(memory = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!memory) {
        const { path } = await rpc.export.account();
        const anchor = document.createElement("a");
        anchor.href = path;
        anchor.download = "account-v2.tar.gz";
        anchor.click();
        return;
      }
      const data = await rpc.memory.export();
      downloadArtifactBytes(
        "memory-v1.json",
        "application/json",
        new TextEncoder().encode(JSON.stringify(data, null, 2)),
      );
    } catch {
      setError(t`Could not export data. Try again.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3 className="text-sm font-medium">
        <Trans>Your data</Trans>
      </h3>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <SettingsRow label={t`Export data`}>
        <Button variant="outline" disabled={busy} onClick={() => void download()}>
          <Trans>Export</Trans>
        </Button>
      </SettingsRow>
      <SettingsRow label={t`Export memory`}>
        <Button variant="outline" disabled={busy} onClick={() => void download(true)}>
          <Trans>Export</Trans>
        </Button>
      </SettingsRow>
      <SettingsRow label={t`Uploaded files`} content={filesOpen ? <UploadedFiles /> : null}>
        <Button
          variant="outline"
          aria-expanded={filesOpen}
          onClick={() => setFilesOpen(!filesOpen)}
        >
          <Trans>Manage</Trans>
        </Button>
      </SettingsRow>
      <SettingsRow label={t`Memory preferences`}>
        <Button variant="outline" onClick={() => navigate("memory")}>
          <Trans>Manage</Trans>
        </Button>
      </SettingsRow>
      <SettingsRow label={t`Learning consent`}>
        <Button variant="outline" onClick={() => navigate("learning")}>
          <Trans>Manage</Trans>
        </Button>
      </SettingsRow>
    </section>
  );
}
