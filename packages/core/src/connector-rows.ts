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
    const catalogId = connection?.catalogId ?? server.catalogId;
    const descriptor = catalogId ? descriptorById.get(catalogId) : undefined;
    const state = connection?.state ?? server.connectionState;
    return {
      id: server.id,
      name: server.name,
      type: server.transport === "stdio" || server.transport === "host-cli" ? "desktop" : "web",
      badges: descriptor
        ? ["included"]
        : server.managedBy
          ? []
          : server.transport === "stdio"
            ? ["custom", "local-dev"]
            : ["custom"],
      status: !server.enabled
        ? "disconnected"
        : server.oauthStatus === "reconnect" ||
            state === "discovery-failed" ||
            state === "needs-sign-in"
          ? "reconnect"
          : server.oauthStatus === "connected" || state === "connected"
            ? "connected"
            : "disconnected",
      catalogId: catalogId ?? undefined,
      available: descriptor?.available ?? true,
    };
  });
  for (const connection of input.connections) {
    if (rows.some((row) => row.id === connection.id)) continue;
    const descriptor = descriptorById.get(connection.catalogId);
    if (!descriptor) continue;
    rows.push({
      id: connection.id,
      name: descriptor.name,
      type:
        connection.transport === "host-cli" || descriptor.transport === "stdio" ? "desktop" : "web",
      badges: ["included"],
      status:
        connection.state === "connected"
          ? "connected"
          : connection.state === "discovery-failed" || connection.state === "needs-sign-in"
            ? "reconnect"
            : "disconnected",
      catalogId: descriptor.id,
      available: descriptor.available,
    });
  }
  if (!input.catalogTab) return rows;
  return input.catalog.map((descriptor) => {
    const connections = rows.filter((row) => row.catalogId === descriptor.id);
    const first =
      connections.find((row) => row.status === "reconnect") ??
      connections.find((row) => row.status === "connected") ??
      connections[0];
    return first
      ? { ...first, name: descriptor.name }
      : {
          id: `catalog:${descriptor.id}`,
          name: descriptor.name,
          type:
            descriptor.transport === "stdio" || descriptor.transport === "host-cli"
              ? "desktop"
              : "web",
          badges: ["included"],
          status: "disconnected",
          catalogId: descriptor.id,
          available: descriptor.available,
        };
  });
}
