import { ModelDestinations } from "../ModelDestinations";
import { ModelSettingsOverlay } from "../ModelSettingsOverlay";
import type { SettingsPageProps } from "../settings-types";
import { RuntimeCapabilityChecks } from "./RuntimeCapabilityChecks";
import { RuntimeReliability } from "./RuntimeReliability";
export default function ModelsSection(props: SettingsPageProps) {
  return (
    <>
      <div className="px-6 pt-5">
        <ModelDestinations />
        <RuntimeCapabilityChecks kind="pi" />
        <RuntimeReliability />
      </div>
      <ModelSettingsOverlay
        embedded
        onOpenBotRuntime={props.onOpenBotRuntime}
        initialProvider={props.initialProvider}
        onClose={props.onClose}
      />
    </>
  );
}
