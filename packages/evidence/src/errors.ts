import type { FormatErrorCode } from "./tables.js";

export class EvidenceFormatError extends Error {
  override readonly name = "EvidenceFormatError";
  constructor(
    readonly code: FormatErrorCode,
    readonly claim: string,
    message: string,
  ) {
    super(`${claim}: ${message}`);
  }
}

export function requireClaim(
  condition: unknown,
  claim: string,
  message = "Invalid value",
): asserts condition {
  if (!condition) throw new EvidenceFormatError("invalid_claim", claim, message);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export const isNonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
export const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/;
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
export const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function epochSeconds(now: Date | (() => Date) = () => new Date()): number {
  const date = typeof now === "function" ? now() : now;
  const seconds = date instanceof Date ? Math.floor(date.getTime() / 1000) : NaN;
  requireClaim(isNonnegativeInteger(seconds) && seconds <= 253402300799, "iat");
  return seconds;
}
