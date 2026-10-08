import { nativeRuntimeProviders, runtimeNames } from "@ardurbot/contracts";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { RuntimeSettings } from "../shell/runtime-settings";

const unchanged = () => undefined;

export function NativeRuntimeSettings({ canConnect }: { canConnect: boolean }) {
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState<keyof typeof nativeRuntimeProviders | null>(null);
  return (
    <details className="mx-6 mt-4 sm:mx-8" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm">
        <Trans>Native runtimes</Trans>
      </summary>
      {open && !canConnect ? (
        <p className="mt-2 text-sm text-muted-foreground">
          <Trans>Set up on the home device</Trans>
        </p>
      ) : null}
      {open
        ? (Object.keys(nativeRuntimeProviders) as (keyof typeof nativeRuntimeProviders)[]).map(
            (kind) => (
              <details
                key={kind}
                className="mt-3"
                onToggle={(event) => {
                  event.stopPropagation();
                  const expanded = event.currentTarget.open;
                  setRuntime((current) => (expanded ? kind : current === kind ? null : current));
                }}
              >
                <summary className="cursor-pointer text-sm">{runtimeNames[kind]}</summary>
                {runtime === kind ? (
                  <RuntimeSettings
                    kind={kind}
                    setupOnly
                    allowConnect={canConnect}
                    experimental={false}
                    onExperimental={unchanged}
                    onKind={unchanged}
                    modelKey=""
                    onModel={unchanged}
                    effort=""
                    onEffort={unchanged}
                  />
                ) : null}
              </details>
            ),
          )
        : null}
    </details>
  );
}
