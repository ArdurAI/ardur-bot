/** Allow only in-product return paths; a shared link never supplies a redirect origin. */
export function authReturnPath(next: string | null): string {
  if (next === "/integrations/setup" || next === "/onboarding") return next;
  if (
    next &&
    /^\/commands\/[^/?#]+\/[^/?#]+(?:\?space=[^&#]+)?$/.test(next) &&
    !next.includes("\\")
  )
    return next;
  if (
    next &&
    !/\s/.test(next) &&
    !Array.from(next).some((c) => c.charCodeAt(0) < 32) &&
    /^\/app(?:\/[^/?#\\]+)*\/?(?:\?[^#\\]*)?$/.test(next) &&
    !next.includes("\\") &&
    !next.includes("//") &&
    !next
      .split("?")[0]!
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  )
    return next;
  return "/app";
}
