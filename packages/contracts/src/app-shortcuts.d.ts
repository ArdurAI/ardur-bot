export type AppShortcutId =
  | "commandPalette"
  | "newBot"
  | "focusMessage"
  | "find"
  | "toggleSidebar"
  | "back"
  | "forward"
  | "settings";
export interface AppShortcut {
  readonly id: AppShortcutId;
  /** Lower-case `KeyboardEvent.key` on a Latin layout. */
  readonly key: string;
  /** `KeyboardEvent.code` of the same physical key, used on non-Latin layouts. */
  readonly code: string;
  readonly shift: boolean;
  /** Also runs while a text field has focus. */
  readonly typing: boolean;
}
export interface AppShortcutKeys {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
export const APP_SHORTCUTS: readonly AppShortcut[];
export function isAppShortcutId(value: unknown): value is AppShortcutId;
export function appShortcut(id: AppShortcutId): AppShortcut;
export function matchAppShortcut(event: AppShortcutKeys, apple: boolean): AppShortcut | undefined;
export function appShortcutLabel(id: AppShortcutId, apple: boolean): string;
export function appShortcutAria(id: AppShortcutId, apple: boolean): string;
export function appShortcutAccelerator(id: AppShortcutId): string;
export function appShortcutsEnabled(url: string): boolean;
