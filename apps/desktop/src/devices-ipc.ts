import type { DesktopInstanceMode } from "@ardurbot/contracts";
import { LOCAL_SETTINGS_TOKEN_HEADER } from "@ardurbot/contracts/local-settings";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { app, ipcMain, net } from "electron";
import type { LocalStackController } from "./local-stack.js";
import { readStackToken, stackDir } from "./local-stack.js";
import type { RemoteListener } from "./remote-listener.js";
import { isLoopbackHost, normalizeServerUrl } from "./setup-config.js";

const MANAGED_HOME_REQUIRED =
  "Phone pairing needs a home run by this app. Set up This computer to use it.";

export function installDevices(options: {
  window(): BrowserWindow | null;
  target(): string | null;
  mode(): DesktopInstanceMode | undefined;
  stack: LocalStackController;
  listener: RemoteListener;
}) {
  function target() {
    const origin = normalizeServerUrl(options.target() ?? "");
    if (!origin || !isLoopbackHost(new URL(origin).hostname)) return null;
    if (options.mode() === "new" && origin === new URL(options.stack.webUrl()).origin)
      return { origin, development: false };
    if (!app.isPackaged && process.env.ARDURBOT_DESKTOP_STACK_TOKEN?.trim())
      return { origin, development: true };
    return null;
  }
  function trusted(event: IpcMainInvokeEvent) {
    const window = options.window();
    return (
      !!window &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      normalizeServerUrl(event.senderFrame?.url ?? "") ===
        normalizeServerUrl(options.target() ?? "")
    );
  }
  function state() {
    const available = !!target();
    return {
      ...options.listener.state(),
      mode: options.mode(),
      available,
      ...(!available ? { reason: MANAGED_HOME_REQUIRED } : {}),
    };
  }
  async function stackToken(home: { development: boolean }) {
    return home.development
      ? process.env.ARDURBOT_DESKTOP_STACK_TOKEN?.trim()
      : await readStackToken(stackDir(app.getPath("userData")));
  }
  async function publish(origin: string, token: string) {
    const response = await net.fetch(`${origin}/local/device-listener-state`, {
      method: "POST",
      headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify(options.listener.state()),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
      bypassCustomProtocolHandlers: true,
    });
    if (!response.ok) throw new Error("Update your home before pairing a phone.");
  }
  ipcMain.handle("desktop.devices.state", async (event) => {
    if (!trusted(event)) throw new Error("Open Devices on your Mac.");
    const home = target();
    if (home && options.listener.state().enabled) {
      const token = await stackToken(home);
      if (!token) throw new Error("Start your home before pairing a phone.");
      await publish(home.origin, token);
    }
    return state();
  });
  ipcMain.handle("desktop.devices.setEnabled", async (event, enabled: unknown) => {
    if (!trusted(event) || typeof enabled !== "boolean")
      throw new Error("Open Devices on your Mac.");
    const home = target();
    if (!home) throw new Error(MANAGED_HOME_REQUIRED);
    const token = await stackToken(home);
    if (!enabled) {
      await options.listener.stop();
      if (token) await publish(home.origin, token);
      return state();
    }
    if (!token || (!home.development && !(await options.stack.matchesDesiredStack())))
      throw new Error("Start your home before pairing a phone.");
    const response = await net.fetch(`${home.origin}/local/device-listener`, {
      method: "POST",
      headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token },
      redirect: "error",
      bypassCustomProtocolHandlers: true,
    });
    if (!response.ok) throw new Error("Update your home before pairing a phone.");
    const material = (await response.json()) as {
      certificate: string;
      privateKey: string;
      certificateFingerprint: string;
    };
    try {
      await options.listener.start({ ...material, target: home.origin });
      await publish(home.origin, token);
    } catch (error) {
      await options.listener.stop();
      // Clear any earlier approval. A failed cleanup also expires after its short lease.
      await publish(home.origin, token).catch(() => undefined);
      throw error;
    }
    return state();
  });
}
