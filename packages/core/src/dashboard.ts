import type {
  ConnectionOverview,
  DeviceGrantView,
  IntegrationCatalogList,
  McpServer,
  MessagingChannelMembership,
  RunActivityRow,
  TeamRow,
} from "@ardurbot/contracts";

export type OverviewNow = { runs: RunActivityRow[]; rows: TeamRow[] };

export function connectionOverview(input: {
  integrations: IntegrationCatalogList;
  servers: Pick<McpServer, "id" | "name" | "enabled" | "oauthStatus">[];
  devices: Pick<DeviceGrantView, "id" | "deviceName" | "kind" | "revokedAt">[];
  channels: MessagingChannelMembership[];
}): ConnectionOverview[] {
  const connected = new Set(input.integrations.connections.map((row) => row.catalogId));
  const integrationIds = new Set(input.integrations.connections.map((row) => row.id));
  const servers = new Map(input.servers.map((row) => [row.id, row]));
  return [
    ...input.integrations.connections.map(
      (row): ConnectionOverview => ({
        id: row.id,
        kind: "integration",
        name:
          input.integrations.catalog.find((entry) => entry.id === row.catalogId)?.name ??
          row.catalogId,
        state:
          row.state === "connected"
            ? servers.get(row.id)?.enabled === false
              ? "not-connected"
              : servers.get(row.id)?.oauthStatus === "reconnect"
                ? "needs-sign-in"
                : "connected"
            : row.state === "discovery-failed"
              ? "error"
              : ["awaiting-consent", "needs-client-registration"].includes(row.state)
                ? "needs-sign-in"
                : "not-connected",
      }),
    ),
    ...input.integrations.catalog
      .filter((row) => row.available && !connected.has(row.id))
      .map(
        (row): ConnectionOverview => ({
          id: row.id,
          name: row.name,
          kind: "integration",
          state: "not-connected",
        }),
      ),
    ...input.servers
      .filter((row) => !integrationIds.has(row.id))
      .map(
        (row): ConnectionOverview => ({
          id: row.id,
          name: row.name,
          kind: "mcp",
          state: !row.enabled
            ? "not-connected"
            : row.oauthStatus === "reconnect"
              ? "needs-sign-in"
              : "connected",
        }),
      ),
    ...input.devices.map(
      (row): ConnectionOverview => ({
        id: row.id,
        name: row.deviceName,
        kind: "device",
        state: row.revokedAt ? "not-connected" : "connected",
      }),
    ),
    ...input.channels.map(
      (row): ConnectionOverview => ({
        id: row.id,
        name: row.name ?? row.provider,
        kind: "channel",
        state:
          row.status === "approved"
            ? "connected"
            : row.status === "invited"
              ? "needs-sign-in"
              : "not-connected",
      }),
    ),
  ];
}

export function activeDelegations(rows: TeamRow[]) {
  const seen = new Set<string>();
  return rows.flatMap((row) =>
    row.delegations.flatMap((delegation) => {
      if (
        seen.has(delegation.id) ||
        !["queued", "running", "cancel-requested"].includes(delegation.status)
      )
        return [];
      seen.add(delegation.id);
      return [delegation];
    }),
  );
}

export function sparklinePoints(values: number[]): string {
  const ceiling = Math.max(1, ...values);
  return values
    .map(
      (value, index) =>
        `${2 + (index * 116) / Math.max(1, values.length - 1)},${30 - (Math.max(0, value) / ceiling) * 28}`,
    )
    .join(" ");
}
