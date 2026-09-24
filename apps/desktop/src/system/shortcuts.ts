import type { GlobalShortcut, Input } from "electron";
import type { Shortcut, ShortcutAction, SystemPreferences } from "./contract.js";
import { SHORTCUT_OPTIONS } from "./contract.js";

export const SHORTCUT_CONFLICT = "That shortcut is already in use; choose another.";
const ACTIONS: ShortcutAction[] = ["quickAccess", "voice", "dictation"];
type Selection = Pick<SystemPreferences, ShortcutAction>;

export function shortcutIdentity(shortcut: Shortcut, platform: string): string {
  return shortcut
    .replace("CommandOrControl", platform === "darwin" ? "Meta" : "Control")
    .toLowerCase();
}

/** Reserve new keys before releasing old ones, so refusing a conflict preserves the old binding. */
export class SystemShortcuts {
  private current: Selection = { quickAccess: "Off", voice: "Off", dictation: "Off" };
  constructor(
    private readonly api: Pick<GlobalShortcut, "register" | "unregister">,
    private readonly platform: string,
    private readonly invoke: (action: ShortcutAction) => void,
  ) {}

  apply(next: Selection): void {
    const identities = new Set<string>();
    for (const action of ACTIONS) {
      const value = next[action];
      if (!SHORTCUT_OPTIONS[action].includes(value))
        throw new Error("Choose an available shortcut.");
      if (value === "Off") continue;
      const identity = shortcutIdentity(value, this.platform);
      if (identities.has(identity)) throw new Error(SHORTCUT_CONFLICT);
      identities.add(identity);
    }
    const previousGlobal = new Set(
      [this.current.quickAccess, this.current.voice].filter((v) => v !== "Off"),
    );
    const nextGlobal = new Set([next.quickAccess, next.voice].filter((v) => v !== "Off"));
    const acquired: Shortcut[] = [];
    try {
      for (const key of nextGlobal) {
        if (previousGlobal.has(key)) continue;
        if (
          !this.api.register(key, () => {
            for (const action of ["quickAccess", "voice"] as const)
              if (this.current[action] === key) this.invoke(action);
          })
        )
          throw new Error(SHORTCUT_CONFLICT);
        acquired.push(key);
      }
    } catch {
      for (const key of acquired) this.api.unregister(key);
      throw new Error(SHORTCUT_CONFLICT);
    }
    this.current = { ...next };
    for (const key of previousGlobal) if (!nextGlobal.has(key)) this.api.unregister(key);
  }

  handleInput(
    input: Pick<Input, "type" | "key" | "control" | "meta" | "alt" | "shift" | "isAutoRepeat">,
  ): boolean {
    if (input.type !== "keyDown" || input.isAutoRepeat || this.current.dictation === "Off")
      return false;
    const parts = shortcutIdentity(this.current.dictation, this.platform).split("+");
    if (
      input.key.toLowerCase() !== parts.at(-1) ||
      input.control !== parts.includes("control") ||
      input.meta !== parts.includes("meta") ||
      input.alt !== parts.includes("alt") ||
      input.shift !== parts.includes("shift")
    )
      return false;
    this.invoke("dictation");
    return true;
  }

  dispose(): void {
    this.apply({ quickAccess: "Off", voice: "Off", dictation: "Off" });
  }
}
