export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "ardurbot.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  chatUserForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  link: string;
  success: string;
  warning: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
};

export const darkTokens = {
  background: "#0E0D0C",
  foreground: "#ECE8E1",
  card: "#141210",
  cardForeground: "#ECE8E1",
  popover: "#141210",
  popoverForeground: "#ECE8E1",
  primary: "#ECE8E1",
  primaryForeground: "#0E0D0C",
  secondary: "#24211E",
  secondaryForeground: "#ECE8E1",
  chatUser: "#24211E",
  chatUserForeground: "#ECE8E1",
  muted: "#141210",
  mutedForeground: "#8D8780",
  accent: "#302B26",
  accentForeground: "#ECE8E1",
  destructive: "#EF4444",
  destructiveForeground: "#0E0D0C",
  border: "#24211E",
  input: "#24211E",
  ring: "#ECE8E1",
  sidebar: "#141210",
  sidebarForeground: "#ECE8E1",
  sidebarBorder: "#24211E",
  sidebarAccent: "#24211E",
  sidebarAccentForeground: "#ECE8E1",
  link: "#ECE8E1",
  success: "#4ECB71",
  warning: "#E9C46A",
  overlay: "rgba(14, 13, 12, 0.72)",
  scrollbar: "#24211E",
  scrollbarHover: "#433D38",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#F6F3EC",
  foreground: "#1C1A17",
  card: "#FFFFFF",
  cardForeground: "#1C1A17",
  popover: "#FFFFFF",
  popoverForeground: "#1C1A17",
  primary: "#1C1A17",
  primaryForeground: "#F6F3EC",
  secondary: "#E3DED3",
  secondaryForeground: "#1C1A17",
  chatUser: "#E3DED3",
  chatUserForeground: "#1C1A17",
  muted: "#FFFFFF",
  mutedForeground: "#6B655D",
  accent: "#D8D2C6",
  accentForeground: "#1C1A17",
  destructive: "#DC2626",
  destructiveForeground: "#FFFFFF",
  border: "#E3DED3",
  input: "#E3DED3",
  ring: "#1C1A17",
  sidebar: "#FFFFFF",
  sidebarForeground: "#1C1A17",
  sidebarBorder: "#E3DED3",
  sidebarAccent: "#E3DED3",
  sidebarAccentForeground: "#1C1A17",
  link: "#1C1A17",
  success: "#228B3B",
  warning: "#B7791F",
  overlay: "rgba(28, 26, 23, 0.45)",
  scrollbar: "#E3DED3",
  scrollbarHover: "#C4BFAF",
} as const satisfies ColorTokens;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "10px";
export const fontStacks = {
  sans: '"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif',
  serif: '"Instrument Serif", ui-serif, Georgia, Cambria, "Times New Roman", serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as const;

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof ColorTokens): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(selector: string, colorScheme: ResolvedAppearance, palette: ColorTokens) {
  const lines = (Object.keys(palette) as (keyof ColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @ardurbot/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
    `:root {\n${Object.entries(fontStacks)
      .map(([name, stack]) => `  --chat-font-${name}: ${stack};`)
      .join("\n")}\n}`,
  ].join("\n\n")}\n`;
}
