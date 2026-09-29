import { homedir } from "node:os";
import path from "node:path";
import { resolveEncryptionKey } from "@ardurbot/core";
import { secretEnvironment } from "@ardurbot/core/node/service-secrets";
import { FleetService } from "@ardurbot/host-runtime/fleet/service";

let service: FleetService | undefined;
export function localFleetService() {
  service ??= new FleetService(
    path.join(homedir(), ".ardurbot", "host"),
    resolveEncryptionKey(secretEnvironment()),
  );
  return service;
}
export { hostCapacity } from "@ardurbot/host-runtime/fleet/capacity";
export { discoverFleet } from "@ardurbot/host-runtime/fleet/discovery";
export { SshSandboxProvider } from "@ardurbot/host-runtime/fleet/ssh-sandbox";
