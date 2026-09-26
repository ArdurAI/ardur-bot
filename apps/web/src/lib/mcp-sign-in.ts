import { t } from "@lingui/core/macro";

const NEEDS_SIGN_IN = /^Needs sign-in(?: \(([a-z_]+)\))?\.$/;

/**
 * The sentence for a stored "Needs sign-in (<code>)." diagnostic, or null for any other
 * text. The code itself is never shown.
 */
export function mcpSignInSentence(recorded: string | null | undefined): string | null {
  const match = recorded?.trim().match(NEEDS_SIGN_IN);
  if (!match) return null;
  switch (match[1]) {
    case "oauth_unavailable":
      return t`This server did not offer browser sign-in. Enter a token instead.`;
    case "refresh_unavailable":
      return t`The saved sign-in expired. Connect again.`;
    case "invalid_token":
      return t`That token was not accepted. Check it and try again.`;
    default:
      return t`Sign-in is needed. Connect again.`;
  }
}

/** A recorded failure as a person reads it: the sign-in sentence, or the stored sentence. */
export function mcpFailureSentence(recorded: string | null | undefined): string | null {
  return mcpSignInSentence(recorded) ?? (recorded?.trim() || null);
}
