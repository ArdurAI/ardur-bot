/**
 * Plain JavaScript on purpose: the packaged desktop app loads compiled JS only.
 * See device-paths.js and host-environment.js for the same pattern.
 */
export function hostRegistrationIdentityText(tokenHash) {
  return `ardurbot:host-registration:v1:${tokenHash}`;
}
