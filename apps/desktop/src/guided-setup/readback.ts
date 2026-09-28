import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";
export interface GuidedAccountStatus {
  /** Digest supplied by the authenticated account RPC; never a user or space ID. */
  scope: string;
  model: "missing" | "saved" | "checked";
  firstBot: boolean;
}

/** A proof binds the journal to the saved target without retaining its URL. */
export function targetProof(target: string | null): string | null {
  if (!target) return null;
  return createHash("sha256").update(target).digest("hex").slice(0, 20);
}

/** Main-process read-back through the authenticated app session. */
export async function readGuidedAccountStatus(
  window: BrowserWindow | null,
  target: string | null,
): Promise<GuidedAccountStatus | null> {
  if (!window || window.isDestroyed() || !target) return null;
  try {
    const origin = new URL(target).origin;
    if (new URL(window.webContents.getURL()).origin !== origin) return null;
    const selected: unknown = await window.webContents.executeJavaScript(
      'localStorage.getItem("ardurbot:space-id")',
    );
    const space = typeof selected === "string" && selected.length <= 128 ? selected : null;
    const response = await window.webContents.session.fetch(
      new URL("/rpc/guidedSetup/status", target).href,
      {
        method: "POST",
        credentials: "include",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(space ? { "x-ardurbot-space-id": space } : {}),
        },
        body: JSON.stringify({ json: {} }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const status = body && typeof body === "object" && "json" in body ? body.json : null;
    if (!status || typeof status !== "object") return null;
    if (
      !("scope" in status) ||
      typeof status.scope !== "string" ||
      !/^[a-f0-9]{64}$/.test(status.scope)
    )
      return null;
    if (!("model" in status) || !["missing", "saved", "checked"].includes(String(status.model)))
      return null;
    if (!("firstBot" in status) || typeof status.firstBot !== "boolean") return null;
    return status as GuidedAccountStatus;
  } catch {
    return null;
  }
}
