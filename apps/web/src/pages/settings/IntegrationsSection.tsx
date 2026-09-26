import { lazy } from "react";
import type { SettingsPageProps } from "../settings-types";

const IntegrationCatalog = lazy(() =>
  import("../../components/integrations/catalog/IntegrationCatalog").then((module) => ({
    default: module.IntegrationCatalog,
  })),
);

export default function IntegrationsSection({
  initialIntegration,
  onBusyChange,
  navigate,
}: SettingsPageProps) {
  return (
    <IntegrationCatalog
      reconnectId={initialIntegration}
      onBusyChange={onBusyChange}
      onOpenMcp={(serverId) => navigate("mcp", serverId)}
    />
  );
}
