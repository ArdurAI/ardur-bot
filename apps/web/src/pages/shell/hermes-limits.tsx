import type { RuntimeConfigPanelProps } from "./runtime-config-panel";
import { RuntimeConfigPanel } from "./runtime-config-panel";

export { RuntimeConfigPanel };
export type { RuntimeConfigPanelProps };

export function HermesLimits(props: RuntimeConfigPanelProps) {
  return <RuntimeConfigPanel {...props} />;
}

export default HermesLimits;
