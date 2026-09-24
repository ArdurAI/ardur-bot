/** Allow only in-product return paths; a shared link never supplies a redirect origin. */
export function authReturnPath(next: string | null): string {
  if (next === "/integrations/setup") return next;
  if (
    next &&
    /^\/commands\/[^/?#]+\/[^/?#]+(?:\?space=[^&#]+)?$/.test(next) &&
    !next.includes("\\")
  )
    return next;
  return "/app";
}
