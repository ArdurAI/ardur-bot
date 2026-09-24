import { MemorySettingsOverlay } from "../MemorySettingsOverlay";
import type { SettingsPageProps } from "../settings-types";
export default function MemorySection(props: SettingsPageProps) {
  return (
    <MemorySettingsOverlay
      embedded
      config={props.memoryConfig}
      onConfigChange={props.onMemoryConfigChange}
      onClose={props.onClose}
      onBusyChange={props.onBusyChange}
    />
  );
}
