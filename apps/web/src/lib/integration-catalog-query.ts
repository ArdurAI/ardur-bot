import type { IntegrationCatalogList } from "@ardurbot/contracts";
import { rpc, selectedSpaceId } from "./rpc";
import { sharedInflight } from "./shared-inflight";

const inflight = new Map<string, Promise<IntegrationCatalogList>>();
const listeners = new Set<(value: IntegrationCatalogList) => void>();

/** Settings and the composer share one request and event-driven updates. */
export async function refreshIntegrationCatalog() {
  const spaceId = selectedSpaceId() ?? "";
  const result = await sharedInflight(inflight, spaceId, () => rpc.integrations.list());
  if ((selectedSpaceId() ?? "") === spaceId) {
    for (const listener of listeners) listener(result);
  }
  return result;
}

export function subscribeIntegrationCatalog(listener: (value: IntegrationCatalogList) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
