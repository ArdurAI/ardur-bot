import { lazy } from "react";
import type { SettingsPageProps } from "../settings-types";

const McpServersOverlay = lazy(() =>
  import("../McpServersOverlay").then((module) => ({ default: module.McpServersOverlay })),
);

export default function McpSection(props: SettingsPageProps) {
  return <McpServersOverlay embedded onClose={props.onClose} onBusyChange={props.onBusyChange} />;
}
