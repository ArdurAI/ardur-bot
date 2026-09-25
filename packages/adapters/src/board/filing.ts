/** Beads metadata values are one argv token, so the stored name stays inside that grammar. */
export function filingBotName(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._'’-]/gu, "")
    .trim()
    .slice(0, 80);
  return /^[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "bot";
}
