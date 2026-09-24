import { lazy } from "react";
import type { SettingsPageProps } from "../settings-types";

const IntegrationCatalog = lazy(() =>
  import("../../components/integrations/card/IntegrationCards").then((module) => ({
    default: module.IntegrationCards,
  })),
);

export default function IntegrationsSection({
  initialIntegration,
  onBusyChange,
}: SettingsPageProps) {
  return <IntegrationCatalog reconnectId={initialIntegration} onBusyChange={onBusyChange} />;
}
