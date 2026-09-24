export const DEVICE_API_PATHS: readonly [
  "/device/pair",
  "/device/code",
  "/device/claim",
  "/device/nonce",
  "/device/request",
];
export function isDeviceApiPath(path: string): boolean;
