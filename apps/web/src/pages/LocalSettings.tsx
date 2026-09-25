import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { ModelSettingsOverlay } from "./ModelSettingsOverlay";

export function LocalSettingsPage() {
  const [section, setSection] = useState<"models" | "integrations" | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const hasLocalSettings = !!desktopBridge()?.localSettings;
  useEffect(() => {
    if (!hasLocalSettings) return;
    let active = true;
    void rpc.integrationSetup
      .get()
      .then(() => {
        if (active) setReady(true);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [hasLocalSettings]);
  return (
    <main className="h-full overflow-auto bg-background px-6 py-12">
      <div className="mx-auto max-w-xl space-y-6">
        <h1 className="text-2xl font-medium">
          <Trans>Local Server Settings</Trans>
        </h1>
        {!hasLocalSettings ? (
          <p role="alert">
            <Trans>Open local settings from the desktop app on the server’s computer.</Trans>
          </p>
        ) : error ? (
          <p role="alert">
            <Trans>Could not reach the local server. Start it and try again.</Trans>
          </p>
        ) : null}
        {ready ? (
          <>
            <nav className="flex gap-2">
              <Button variant="outline" onClick={() => setSection("models")}>
                <Trans>Models</Trans>
              </Button>
              <Button
                variant="outline"
                onClick={() => setSection(section === "integrations" ? null : "integrations")}
              >
                <Trans>Server integrations</Trans>
              </Button>
            </nav>
            {section === "models" ? (
              <ModelSettingsOverlay onClose={() => setSection(null)} localOwner />
            ) : null}
            {section === "integrations" ? <IntegrationSetup serverSetup managedOnly /> : null}
          </>
        ) : null}
      </div>
    </main>
  );
}
