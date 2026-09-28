import { GUIDED_SETUP_CHANNELS } from "@ardurbot/contracts/desktop-setup";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS } from "../../e2e/guided-setup-fixture-channels.js";
import { installGuidedSetupIpc } from "./ipc.js";
import type { SetupEngine } from "./engine.js";

describe("guided setup lifecycle fixture", () => {
  it("removes every request handler before installing its engine", () => {
    const requestChannels = Object.values(GUIDED_SETUP_CHANNELS).filter(
      (channel) => channel !== GUIDED_SETUP_CHANNELS.changed,
    );
    expect(GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS).toEqual(requestChannels);
  });
  it("replaces real production registrations without duplicate IPC handlers", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle(channel: string, handler: (...args: unknown[]) => unknown) {
        if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
        handlers.set(channel, handler);
      },
      removeHandler(channel: string) {
        handlers.delete(channel);
      },
    };
    const engine = { onChange: () => () => undefined } as unknown as SetupEngine;
    const install = () =>
      installGuidedSetupIpc({
        ipc,
        window: () => null,
        engine,
        startup: { supported: () => false, enabled: () => false, set: () => undefined },
      });
    install();
    ipc.handle(GUIDED_SETUP_CHANNELS.openAgain, () => undefined);
    expect(() => {
      for (const channel of GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS) ipc.removeHandler(channel);
      install();
    }).not.toThrow();
    for (const channel of GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS) {
      if (channel !== GUIDED_SETUP_CHANNELS.openAgain) expect(handlers.has(channel)).toBe(true);
    }
    const lifecycle = readFileSync(
      fileURLToPath(new URL("../../e2e/guided-setup-lifecycle.spec.ts", import.meta.url)),
      "utf8",
    );
    expect(lifecycle).toContain("for (const channel of requestChannels) ipcMain.removeHandler(channel)");
    expect(lifecycle).toContain("}, GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS)");
  });
});
