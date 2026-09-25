import { LOCAL_SETTINGS_TOKEN_HEADER } from "@ardurbot/contracts/local-settings";
import { isLoopbackHost } from "../setup-config.js";

export async function readEnabledRoutines(
  target: string,
  token: string,
  request: typeof fetch,
): Promise<number> {
  const url = new URL(target);
  if (!isLoopbackHost(url.hostname) || !["http:", "https:"].includes(url.protocol))
    throw new Error("Routine status requires the local desktop stack.");
  const response = await request(`${url.origin}/local/system/routines`, {
    headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token },
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Could not read routine status.");
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    !("count" in value) ||
    typeof value.count !== "number" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  )
    throw new Error("Could not read routine status.");
  return value.count;
}
