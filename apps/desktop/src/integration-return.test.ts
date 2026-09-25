import { describe, expect, it, vi } from "vitest";
import {
  focusIntegration,
  integrationReturnId,
  registerIntegrationProtocol,
} from "./integration-return.js";

describe("desktop integration return", () => {
  it("registers the scheme only in packaged builds", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    registerIntegrationProtocol({ isPackaged: false, setAsDefaultProtocolClient });
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
    registerIntegrationProtocol({ isPackaged: true, setAsDefaultProtocolClient });
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("ardurbot");
  });
  it("accepts only integration routes without credentials, queries or nested paths", () => {
    expect(integrationReturnId("ardurbot://integrations/connection")).toBe("connection");
    expect(integrationReturnId("ardurbot://integrations")).toBe("");
    for (const url of [
      "https://integrations/connection",
      "ardurbot://integrations/a/b",
      "ardurbot://integrations/a?token=fake",
      "ardurbot://other/a",
      "ardurbot://user@integrations/a",
      "ardurbot://integrations/%2e%2e",
    ])
      expect(integrationReturnId(url)).toBeNull();
  });
  it("restores and focuses the window, then tells the renderer which card to open", () => {
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    };
    focusIntegration(window, "connection");
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(
      "desktop.integrations.return",
      "connection",
    );
  });
});
