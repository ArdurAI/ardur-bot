import { Button } from "@ardurbot/ui-web";
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import type { DesktopStorageRow, StorageBridge } from "./bridge";
import { storageBridge } from "./bridge";

function formatSize(bytes: number) {
  const locale = i18n.locale || "en";
  const format = (value: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${format(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${format(bytes / 1024 ** 2)} MB`;
  return `${format(bytes / 1024 ** 3)} GB`;
}

export function StorageSettings({ bridge = storageBridge() }: { bridge?: StorageBridge }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<DesktopStorageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge
      .usage()
      .then((value) => {
        if (active) setRows(value);
      })
      .catch(() => {
        if (active) setError(t`Could not read storage usage; try again.`);
      });
    return () => {
      active = false;
    };
  }, [bridge, t]);

  async function clearCaches() {
    if (!bridge) return;
    setBusy(true);
    setError(null);
    try {
      setRows(await bridge.clearCaches());
    } catch {
      setError(t`Could not clear caches; try again.`);
    } finally {
      setBusy(false);
    }
  }

  const rowLabel: Record<DesktopStorageRow["id"], string> = {
    database: t`Database`,
    computerHomes: t`Computer homes`,
    checkpoints: t`Checkpoints`,
    artifacts: t`Artifacts`,
    boards: t`Boards`,
    sessions: t`Sessions`,
    appCache: t`App cache`,
    previousDockerData: t`Previous Docker data`,
  };

  const rowDescription = (row: DesktopStorageRow) => {
    const location = row.paths.join(", ");
    return row.dockerUnavailable ? t`${location} · Docker not running` : location;
  };

  const rowSize = (row: DesktopStorageRow) => {
    const size = formatSize(row.bytes);
    return row.approximate ? t`at least ${size}` : size;
  };

  if (!bridge)
    return (
      <p className="text-sm text-muted-foreground">{t`Restart the desktop app to see storage usage.`}</p>
    );
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  if (!rows) return <div role="status">{t`Reading storage usage…`}</div>;

  return (
    <>
      {rows.map((row) => (
        <SettingsRow key={row.id} label={rowLabel[row.id]} description={rowDescription(row)}>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{rowSize(row)}</span>
            {row.id === "appCache" ? (
              <Button variant="outline" disabled={busy} onClick={() => void clearCaches()}>
                {t`Clear caches`}
              </Button>
            ) : null}
          </div>
        </SettingsRow>
      ))}
    </>
  );
}

export default function StorageSettingsPage() {
  return <StorageSettings />;
}
