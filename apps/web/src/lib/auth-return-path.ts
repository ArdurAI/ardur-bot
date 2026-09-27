/** Allow only in-product return paths; a shared link never supplies a redirect origin. */
export function authReturnPath(next: string | null): string {
  if (
    !next ||
    next.includes("//") ||
    next.includes("\\") ||
    /\s/.test(next) ||
    Array.from(next).some((character) => character.charCodeAt(0) < 32) ||
    next
      .split("?")[0]!
      .split("/")
      .some((segment) => {
        try {
          const decoded = decodeURIComponent(segment);
          return decoded === "." || decoded === "..";
        } catch {
          return true;
        }
      })
  )
    return "/app";
  if (/^\/(?:integrations\/setup|mcp\/oauth\/callback|onboarding)(?:\?[^#]*)?$/.test(next))
    return next;
  if (/^\/commands\/[^/?#]+\/[^/?#]+(?:\?space=[^&#]+)?$/.test(next)) return next;
  if (/^\/app(?:\/[^/?#\\]+)*\/?(?:\?[^#\\]*)?$/.test(next)) return next;
  return "/app";
}
