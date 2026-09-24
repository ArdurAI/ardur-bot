import { describe, expect, it, vi } from "vitest";
import { isCommandPaletteHotkey } from "./command-palette-hotkey";

function keyEvent(partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...partial,
  } as KeyboardEvent;
}

describe("isCommandPaletteHotkey", () => {
  it("matches Cmd/Ctrl-K", () => {
    expect(isCommandPaletteHotkey(keyEvent({ key: "k", metaKey: true }))).toBe(true);
    expect(isCommandPaletteHotkey(keyEvent({ key: "K", ctrlKey: true }))).toBe(true);
  });

  it("rejects other chords", () => {
    expect(isCommandPaletteHotkey(keyEvent({ key: "k" }))).toBe(false);
    expect(isCommandPaletteHotkey(keyEvent({ key: "k", metaKey: true, shiftKey: true }))).toBe(
      false,
    );
    expect(isCommandPaletteHotkey(keyEvent({ key: "k", metaKey: true, altKey: true }))).toBe(false);
    expect(isCommandPaletteHotkey(keyEvent({ key: "k", metaKey: true, repeat: true }))).toBe(false);
    expect(isCommandPaletteHotkey(keyEvent({ key: "j", metaKey: true }))).toBe(false);
  });
  it("leaves shell shortcuts with the focused terminal", () => {
    class Element {
      closest() {
        return this;
      }
    }
    vi.stubGlobal("Element", Element);
    try {
      expect(
        isCommandPaletteHotkey(
          keyEvent({ key: "k", ctrlKey: true, target: new Element() as unknown as EventTarget }),
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
