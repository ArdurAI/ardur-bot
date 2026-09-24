import { Gauge } from "lucide-react";
import CapabilitiesSettings from "./CapabilitiesSettings";

export function capabilitiesSection(
  label: string,
  navigate: (section: "computer" | "customize") => void,
) {
  return {
    id: "capabilities" as const,
    label,
    icon: Gauge,
    page: <CapabilitiesSettings navigate={navigate} />,
  };
}
