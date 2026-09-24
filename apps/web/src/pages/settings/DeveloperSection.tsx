import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { desktopBridge } from "../../lib/desktop";

export default function DeveloperSection() {
  const { t } = useLingui();
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    let active = true;
    void desktopBridge()
      ?.update?.state()
      .then((state) => {
        if (active) setVersion(state.currentVersion);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <SettingsRow label={t`Server URL`}>
        <span className="break-all text-sm text-muted-foreground">{window.location.origin}</span>
      </SettingsRow>
      {version ? (
        <SettingsRow label={t`App version`}>
          <span className="text-sm text-muted-foreground">{version}</span>
        </SettingsRow>
      ) : null}
    </>
  );
}
