import type { Me, ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import { useEffect, useState } from "react";
import { rpc } from "./rpc";

export type ModelSettings = {
  me: Pick<Me, "defaultProvider" | "defaultModel"> & Partial<Pick<Me, "needsModel">>;
  catalog: ModelCatalogEntry[];
  credentials: ModelCredential[];
};

/** Shell owns this cache; changing the active bot does not reload account data. */
export function useModelSettings(spaceId?: string, settingsOpen = false, enabled = true) {
  const [cached, setCached] = useState<{ spaceId?: string; settings: ModelSettings } | null>(null);
  useEffect(() => {
    if (!enabled || settingsOpen) return;
    let cancelled = false;
    void Promise.all([rpc.me(), rpc.models.list(), rpc.models.credentials()])
      .then(([me, catalog, credentials]) => {
        if (!cancelled) setCached({ spaceId, settings: { me, catalog, credentials } });
      })
      .catch(() => {
        if (!cancelled) setCached(null);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, settingsOpen, enabled]);
  return cached?.spaceId === spaceId ? (cached?.settings ?? null) : null;
}
