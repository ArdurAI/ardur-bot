import { DevicesSettings } from "../DevicesSettings";
import type { SettingsPageProps } from "../settings-types";
export default function DevicesSection(props: SettingsPageProps) {
  return <DevicesSettings owner={props.isDeploymentOwner === true} />;
}
