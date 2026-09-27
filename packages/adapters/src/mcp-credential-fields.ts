/** Classify fields by their names, before values enter an exact-match redactor. */
export function isMcpCredentialField(key: string, header = false): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (header && /^(cookie|set_cookie|x_session)$/.test(normalized)) return true;
  return /(?:^|_)(key|token|secret|password|credential|authorization|session_id)$/.test(normalized);
}
