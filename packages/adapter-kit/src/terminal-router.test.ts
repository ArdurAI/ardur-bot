import { describe, expect, it, vi } from "vitest";
import type { TerminalContext, TerminalProvider } from "./terminal.js";
import { routedTerminal } from "./terminal-router.js";

const computer = { id: "computer", botId: "bot", kind: "desktop" as const, providerRef: "ref" };
const context: TerminalContext = {
  userId: "owner",
  spaceId: "space",
  signal: new AbortController().signal,
  operationId: "open",
  traceId: "open",
  leaseId: "lease",
  fence: 1,
  generation: "ref",
  expiresAt: 100000,
  workingRoot: "/workspace",
};
function provider(): TerminalProvider {
  return {
    open: vi.fn(async () => ({ id: "session", generation: "ref" })),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    async *output() {},
  };
}
describe("terminal session routing", () => {
  it("revokes the opening provider after the selected destination changes", async () => {
    const original = provider();
    const replacement = provider();
    let selected = original;
    const routed = routedTerminal(async () => selected);
    await routed.open(computer, { cols: 80, rows: 24, shellProfileId: "default" }, context);
    selected = replacement;
    await routed.revoke(computer, "lease", context);
    expect(original.revoke).toHaveBeenCalledOnce();
    expect(original.close).toHaveBeenCalledOnce();
    expect(replacement.revoke).not.toHaveBeenCalled();
    await expect(routed.write("session", Uint8Array.of(1))).rejects.toThrow();
  });
  it("waits for an opening session to be killed before revoke resolves", async () => {
    const original = provider();
    let opened!: (value: { id: string; generation: string }) => void;
    vi.mocked(original.open).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    const routed = routedTerminal(async () => original);
    const opening = routed.open(
      computer,
      { cols: 80, rows: 24, shellProfileId: "default" },
      context,
    );
    const failed = expect(opening).rejects.toThrow();
    await vi.waitFor(() => expect(original.open).toHaveBeenCalledOnce());
    let released = false;
    const revoke = routed.revoke(computer, "lease", context).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    opened({ id: "session", generation: "ref" });
    await failed;
    await revoke;
    expect(original.close).toHaveBeenCalledExactlyOnceWith("session", "revoked-during-open");
  });
});
