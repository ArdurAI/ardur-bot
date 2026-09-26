import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient, type ReactAuthClient } from "better-auth/react";

export const authClient: ReactAuthClient<{
  plugins: [ReturnType<typeof organizationClient>];
}> = createAuthClient({
  plugins: [organizationClient()],
});

/**
 * Better Auth delays its session signal in a setTimeout(..., 10) after signIn / signUp,
 * so immediate in-app router navigation can evaluate protected routes against the stale
 * anonymous session. Awaiting refetch on the session atom ensures client session state
 * is synchronized before navigation.
 */
export async function refreshAuthSession(): Promise<void> {
  const sessionAtom = authClient.$store.atoms.session;
  if (sessionAtom) {
    await sessionAtom.get()?.refetch?.();
  }
}
