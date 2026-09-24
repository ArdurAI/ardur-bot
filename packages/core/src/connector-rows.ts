import type { IntegrationConnection, IntegrationDescriptor, McpServer } from "@ardurbot/contracts";

export type ConnectorRow = {
  id: string;
  name: string;
  type: "web" | "desktop";
  badges: ("custom" | "included" | "local-dev")[];
  status: "connected" | "reconnect" | "disconnected";
  catalogId?: string;
  available: boolean;
};
type ManagedServer = McpServer & {
  managedBy?: "extension" | "plugin" | null;
  connectionState?: string;
};

export function connectorRows(input: {
  catalog: IntegrationDescriptor[];
  connections: IntegrationConnection[];
  servers: ManagedServer[];
  catalogTab?: boolean;
}): ConnectorRow[] {
  const connectionById = new Map(input.connections.map((entry) => [entry.id, entry]));
  const descriptorById = new Map(input.catalog.map((entry) => [entry.id, entry]));
  const rows: ConnectorRow[] = input.servers.map((server) => {
    const connection = connectionById.get(server.id);
    const descriptor = connection ? descriptorById.get(connection.catalogId) : undefined;
    const state = connection?.state ?? server.connectionState;
    return {
      id: server.id,
      name: server.name,
      type: server.transport === "stdio" ? "desktop" : "web",
      badges: descriptor
        ? ["included"]
        : server.managedBy
          ? []
          : server.transport === "stdio"
            ? ["custom", "local-dev"]
            : ["custom"],
      status: !server.enabled
        ? "disconnected"
        : server.oauthStatus === "reconnect" || state === "discovery-failed"
          ? "reconnect"
          : server.oauthStatus === "connected" || state === "connected"
            ? "connected"
            : "disconnected",
      catalogId: descriptor?.id,
      available: descriptor?.available ?? true,
    };
  });
  if (!input.catalogTab) return rows;
  return input.catalog.map(
    (descriptor) =>
      rows.find((row) => row.catalogId === descriptor.id) ?? {
        id: `catalog:${descriptor.id}`,
        name: descriptor.name,
        type: descriptor.transport === "stdio" ? "desktop" : "web",
        badges: ["included"],
        status: "disconnected",
        catalogId: descriptor.id,
        available: descriptor.available,
      },
  );
}
