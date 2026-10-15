import { randomUUID } from "node:crypto";
import { outgoingCorrelationHeaders } from "@ardurbot/logging";

export const UPDATE_PAUSED = "Update paused because a bot is still working. Try again.";
export interface UpdateDrain {
  begin(): Promise<boolean>;
  clear(): Promise<void>;
}

/** The updater outlives the services; it must own both drain and reopening admission. */
export function updateDrain(
  apiUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): UpdateDrain {
  let id: string | undefined;
  return {
    async begin() {
      id = randomUUID();
      const response = await fetchImpl(new URL("/api/restart-drain", apiUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...outgoingCorrelationHeaders(),
        },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(65_000),
      });
      if (!response.ok) return false;
      const result = (await response.json()) as { ok?: unknown; id?: unknown };
      if (typeof result.id !== "string") return false;
      id = result.id;
      return result.ok === true;
    },
    async clear() {
      if (!id) return;
      // Recreate can briefly remove the API. Retry reopening within a bounded window.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        try {
          const response = await fetchImpl(new URL("/api/restart-drain/clear", apiUrl), {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              ...outgoingCorrelationHeaders(),
            },
            body: JSON.stringify({ id }),
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok) {
            id = undefined;
            return;
          }
        } catch {
          /* The API may still be starting after recreate or recovery. */
        }
      }
      throw new Error("Could not reopen turn admission after the update.");
    },
  };
}
