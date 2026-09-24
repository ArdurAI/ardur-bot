import type { SettingsPageProps } from "../settings-types";
import { VoiceSettingsOverlay } from "../VoiceSettingsOverlay";
export default function VoiceSection(props: SettingsPageProps) {
  return (
    <VoiceSettingsOverlay embedded onClose={props.onClose} onBusyChange={props.onBusyChange} />
  );
}
