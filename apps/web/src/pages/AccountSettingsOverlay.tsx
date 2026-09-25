import { Trans } from "@lingui/react/macro";
import type { RefObject } from "react";
import { DesktopUpdateSection } from "../components/DesktopUpdates";
import { SoftwareUpdateSection } from "../components/SoftwareUpdateSection";
import { ComputerProfilesSettings } from "./ComputerProfilesSettings";
import { FleetSettings } from "./fleet/FleetSettings";
import { HostComputerSettings } from "./HostComputerSettings";

export function UsageSettingsPanel({
  usage,
  panelRef,
}: {
  usage?: { runs: number; inputTokens: number; outputTokens: number } | null;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="usage-settings"
      className="rounded-xl border border-border px-4 py-4 outline-none"
    >
      <h3 className="text-[15px] font-medium text-foreground">
        <Trans>Usage</Trans>
      </h3>
      {usage ? (
        <p className="mt-3 text-[14px] text-foreground/75">
          <Trans>
            {usage.runs} runs · {usage.inputTokens + usage.outputTokens} tokens
          </Trans>
        </p>
      ) : null}
      <p className={`text-[12.5px] text-muted-foreground/80 ${usage ? "mt-2" : "mt-3"}`}>
        <Trans>Model spend uses your provider keys.</Trans>
      </p>
    </div>
  );
}

export function ComputerSettingsPanel() {
  return (
    <div
      data-testid="computers-setup-settings"
      className="rounded-xl border border-border px-4 py-4"
    >
      <FleetSettings />
      <details>
        <summary>
          <Trans>This computer</Trans>
        </summary>
        <HostComputerSettings />
      </details>
      <ComputerProfilesSettings />
    </div>
  );
}

export function UpdatesSettingsPanel({
  isDeploymentOwner = false,
}: {
  isDeploymentOwner?: boolean;
}) {
  return (
    <div className="space-y-5">
      <DesktopUpdateSection />
      <SoftwareUpdateSection isDeploymentOwner={isDeploymentOwner} />
    </div>
  );
}
