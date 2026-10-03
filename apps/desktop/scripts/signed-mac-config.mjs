import { readFileSync } from "node:fs";

const { build } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const mac = {
  ...build.mac,
  type: "distribution",
  hardenedRuntime: true,
  entitlements: "assets/entitlements.mac.plist",
  entitlementsInherit: "assets/entitlements.mac.plist",
  notarize: true,
  strictVerify: true,
};
// Select Developer ID from the CI job's temporary keychain, never the preview's "-".
delete mac.identity;
export default { ...build, mac, forceCodeSigning: true };
