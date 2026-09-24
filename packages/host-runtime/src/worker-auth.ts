import { createHmac, timingSafeEqual } from "node:crypto";
/** Domain separation keeps the encryption key itself out of HTTP headers. */
export function hostWorkerToken(key: string) {
  return createHmac("sha256", key).update("ardurbot:host-bridge:worker:v1").digest("base64url");
}
export function hostTokenMatches(presented: string | undefined, expected: string) {
  if (!presented) return false;
  const a = Buffer.from(presented),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
