import type { UsageSummary } from "@ardurbot/contracts";
import { Plural, Trans } from "@lingui/react/macro";
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
  usage?: Pick<
    UsageSummary,
    "runs" | "records" | "runCount" | "inputTokens" | "outputTokens"
  > | null;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  const records = usage?.records ?? usage?.runs ?? 0;
  const runs = usage?.runCount;
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
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
          {runs === undefined ? null : (
            <>
              <Plural value={runs} one="# run" other="# runs" />
              {" · "}
            </>
          )}
          <Plural value={records} one="# usage record" other="# usage records" />
          {" · "}
          <Plural value={tokens} one="# token" other="# tokens" />
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
