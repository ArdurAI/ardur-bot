/**
 * Plain JavaScript on purpose: the packaged desktop app loads compiled JS only, and this
 * package otherwise ships TypeScript source. See local-settings.js for the same pattern.
 */
export const DEVICE_API_PATHS = Object.freeze([
  "/device/pair",
  "/device/code",
  "/device/claim",
  "/device/nonce",
  "/device/request",
]);

/** @param {string} path */
export function isDeviceApiPath(path) {
  return DEVICE_API_PATHS.includes(path);
}
