import { describe, expect, it, vi } from "vitest";
import { SystemShortcuts } from "./shortcuts.js";

function fixture(platform = "darwin") {
  const callbacks = new Map<string, () => void>();
  const api = {
    register: vi.fn((key: string, fn: () => void) => {
      callbacks.set(key, fn);
      return true;
    }),
    unregister: vi.fn((key: string) => {
      callbacks.delete(key);
    }),
  };
  const invoke = vi.fn();
  return { callbacks, api, invoke, shortcuts: new SystemShortcuts(api, platform, invoke) };
}

describe("system shortcuts", () => {
  it("registers global actions, routes the callbacks, and cleans up only its own keys", () => {
    const f = fixture();
    f.shortcuts.apply({
      quickAccess: "Alt+Space",
      voice: "CommandOrControl+Shift+V",
      dictation: "CommandOrControl+D",
    });
    f.callbacks.get("Alt+Space")!();
    f.callbacks.get("CommandOrControl+Shift+V")!();
    expect(f.invoke.mock.calls).toEqual([["quickAccess"], ["voice"]]);
    expect(f.api.register).toHaveBeenCalledTimes(2);
    f.shortcuts.dispose();
    f.shortcuts.dispose();
    expect(f.api.unregister.mock.calls).toEqual([["Alt+Space"], ["CommandOrControl+Shift+V"]]);
  });
  it("rejects duplicate bindings before changing the OS", () => {
    const f = fixture();
    expect(() =>
      f.shortcuts.apply({ quickAccess: "Control+Space", voice: "Control+Space", dictation: "Off" }),
    ).toThrow("That shortcut is already in use; choose another.");
    expect(f.api.register).not.toHaveBeenCalled();
  });
  it("preserves the old binding when another application owns the new key", () => {
    const f = fixture();
    f.shortcuts.apply({ quickAccess: "Alt+Space", voice: "Off", dictation: "Off" });
    f.api.register.mockReturnValueOnce(false);
    expect(() =>
      f.shortcuts.apply({ quickAccess: "Control+Space", voice: "Off", dictation: "Off" }),
    ).toThrow("already in use");
    expect(f.api.unregister).not.toHaveBeenCalled();
    f.callbacks.get("Alt+Space")!();
    expect(f.invoke).toHaveBeenCalledWith("quickAccess");
  });
  it("releases partially acquired keys when a later reservation fails", () => {
    const f = fixture();
    f.api.register.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(() =>
      f.shortcuts.apply({ quickAccess: "Alt+Space", voice: "Control+Space", dictation: "Off" }),
    ).toThrow();
    expect(f.api.unregister).toHaveBeenCalledExactlyOnceWith("Alt+Space");
  });
  it("reassigns an existing binding without losing its callback", () => {
    const f = fixture();
    f.shortcuts.apply({ quickAccess: "Control+Space", voice: "Off", dictation: "Off" });
    f.shortcuts.apply({ quickAccess: "Off", voice: "Control+Space", dictation: "Off" });
    f.callbacks.get("Control+Space")!();
    expect(f.invoke).toHaveBeenCalledWith("voice");
    expect(f.api.register).toHaveBeenCalledOnce();
  });
  it.each(["darwin", "win32", "linux"])(
    "handles only the chosen in-window chord on %s",
    (platform) => {
      const f = fixture(platform);
      f.shortcuts.apply({ quickAccess: "Off", voice: "Off", dictation: "CommandOrControl+D" });
      const input = {
        type: "keyDown",
        key: "d",
        control: platform !== "darwin",
        meta: platform === "darwin",
        alt: false,
        shift: false,
        isAutoRepeat: false,
      };
      expect(f.shortcuts.handleInput(input)).toBe(true);
      expect(f.shortcuts.handleInput({ ...input, isAutoRepeat: true })).toBe(false);
      expect(f.shortcuts.handleInput({ ...input, shift: true })).toBe(false);
      expect(f.shortcuts.handleInput({ ...input, type: "keyUp" })).toBe(false);
      expect(f.invoke).toHaveBeenCalledExactlyOnceWith("dictation");
      expect(f.api.register).not.toHaveBeenCalled();
    },
  );
});
