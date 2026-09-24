import { ModelDestinations } from "../ModelDestinations";
import { ModelSettingsOverlay } from "../ModelSettingsOverlay";
import type { SettingsPageProps } from "../settings-types";
export default function ModelsSection(props: SettingsPageProps) {
  return (
    <>
      <div className="px-6 pt-5">
        <ModelDestinations />
      </div>
      <ModelSettingsOverlay
        embedded
        initialProvider={props.initialProvider}
        onClose={props.onClose}
      />
    </>
  );
}
