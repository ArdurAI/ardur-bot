import type { EncryptedSecretStore } from "@ardurbot/adapters";
import type { DeviceListenerState } from "@ardurbot/contracts";
import { DeviceListenerStateSchema } from "@ardurbot/contracts";
import { LOCAL_SETTINGS_TOKEN_HEADER } from "@ardurbot/contracts/local-settings";
import {
  localDeviceTarget,
  RemoteListener,
  validateDeviceListenerConfig,
} from "@ardurbot/host-runtime/device-listener";
import type { Hono } from "hono";
import type { AppEnv } from "./env.js";
import type { ensureInstanceIdentity } from "./instance-identity.js";
import { validLocalSettingsToken } from "./local-settings.js";
import { requestBodyLimit } from "./request-body-limit.js";

export { localDeviceTarget } from "@ardurbot/host-runtime/device-listener";

export function createServerDeviceListener(
  env: Pick<AppEnv, "deviceListener" | "apiHost" | "port">,
  home: Awaited<ReturnType<typeof ensureInstanceIdentity>>,
  secrets: Pick<EncryptedSecretStore, "load">,
  listener = new RemoteListener(),
) {
  let desktopHints: string[] = [];
  let desktopExpiresAt = 0;
  return {
    state: (): DeviceListenerState => listener.state(),
    trustedDesktopHints: () => (Date.now() < desktopExpiresAt ? [...desktopHints] : []),
    approveDesktopState(state: DeviceListenerState) {
      const parsed = DeviceListenerStateSchema.parse(state);
      desktopHints = parsed.enabled
        ? validateDeviceListenerConfig({ bind: "127.0.0.1", port: 43119, hints: parsed.hints })
            .hints
        : [];
      // A stopped or crashed desktop must not leave permanently usable pairing hints.
      desktopExpiresAt = Date.now() + 30_000;
    },
    async start() {
      if (!env.deviceListener) return;
      try {
        await listener.start({
          target: localDeviceTarget(env),
          certificate: home.certificate,
          certificateFingerprint: home.certificateFingerprint,
          privateKey: secrets.load(home.privateKeyCiphertext, home.instanceId),
          listen: env.deviceListener,
        });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EADDRINUSE")
          throw new Error(
            `Device HTTPS listener cannot start: ${env.deviceListener.bind}:${env.deviceListener.port} is already in use.`,
            { cause: error },
          );
        throw error;
      }
    },
    async stop() {
      desktopHints = [];
      desktopExpiresAt = 0;
      await listener.stop();
    },
  };
}

/** The stack token grants local Electron access; browser sessions cannot approve hints. */
export function mountDesktopListenerState(
  app: Hono,
  token: string | undefined,
  devices: Pick<ReturnType<typeof createServerDeviceListener>, "approveDesktopState">,
) {
  app.post("/local/device-listener-state", requestBodyLimit(16 * 1024), async (c) => {
    c.header("cache-control", "no-store");
    if (!validLocalSettingsToken(token, c.req.header(LOCAL_SETTINGS_TOKEN_HEADER)))
      return c.json({ message: "Open device settings on your Mac." }, 403);
    try {
      devices.approveDesktopState(DeviceListenerStateSchema.strict().parse(await c.req.json()));
    } catch {
      return c.json({ message: "Invalid device listener state." }, 400);
    }
    return c.json({ ok: true });
  });
}
