/** The machine-readable code an ORPC error carries in its `data`, when present. Deciding by
 * this code (never by the English text of `message`) keeps a screen's error handling correct
 * across locales and across sentences the server may reword. */
export function errorDataCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("code" in data)) return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
