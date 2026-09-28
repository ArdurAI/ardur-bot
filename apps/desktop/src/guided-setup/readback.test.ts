import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { readGuidedAccountStatus, targetProof } from "./readback.js";

function windowAt(url: string, response: Response) {
  const fetch = vi.fn(async () => response);
  const window = {
    isDestroyed: () => false,
    webContents: {
      getURL: () => url,
      executeJavaScript: async () => "space-a",
      session: { fetch },
    },
  } as unknown as BrowserWindow;
  return { window, fetch };
}

describe("guided account read-back", () => {
  it("sends the selected space only to the bound target session", async () => {
    const { window, fetch } = windowAt(
      "http://127.0.0.1:3333/guided-onboarding",
      Response.json({ json: { scope: "a".repeat(64), model: "saved", firstBot: true } }),
    );
    expect(await readGuidedAccountStatus(window, "http://127.0.0.1:3333/")).toEqual({
      scope: "a".repeat(64),
      model: "saved",
      firstBot: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3333/rpc/guidedSetup/status",
      expect.objectContaining({
        credentials: "include",
        redirect: "error",
        headers: expect.objectContaining({ "x-ardurbot-space-id": "space-a" }),
      }),
    );
    expect(targetProof("http://127.0.0.1:3333/")).toMatch(/^[a-f0-9]{20}$/);
  });

  it("refuses a different origin and an unauthorized response", async () => {
    const other = windowAt("https://other.example.test/", Response.json({ json: {} }));
    expect(await readGuidedAccountStatus(other.window, "https://app.example.test/")).toBeNull();
    expect(other.fetch).not.toHaveBeenCalled();
    const unauthorized = windowAt("https://app.example.test/", new Response(null, { status: 401 }));
    expect(
      await readGuidedAccountStatus(unauthorized.window, "https://app.example.test/"),
    ).toBeNull();
  });
});
