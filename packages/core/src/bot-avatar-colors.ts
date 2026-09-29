export interface GrokColorDef {
  id: string;
  name: string;
  light: string;
  dark: string;
  eyeColor: string;
  hex: string;
}

export const GROK_COLOR_LIST: GrokColorDef[] = [
  {
    id: "bengara",
    name: "Bengara",
    hex: "#9A3B1E",
    light: "#9A3B1E",
    dark: "#9A3B1E",
    eyeColor: "#F6F3EC",
  },
  {
    id: "indigo",
    name: "Indigo",
    hex: "#2F4A7A",
    light: "#2F4A7A",
    dark: "#2F4A7A",
    eyeColor: "#F6F3EC",
  },
  {
    id: "moss",
    name: "Moss",
    hex: "#4E6B2F",
    light: "#4E6B2F",
    dark: "#4E6B2F",
    eyeColor: "#F6F3EC",
  },
  {
    id: "persimmon",
    name: "Persimmon",
    hex: "#A84A22",
    light: "#A84A22",
    dark: "#A84A22",
    eyeColor: "#F6F3EC",
  },
  {
    id: "plum",
    name: "Plum",
    hex: "#7A3F6A",
    light: "#7A3F6A",
    dark: "#7A3F6A",
    eyeColor: "#F6F3EC",
  },
  {
    id: "teal",
    name: "Teal",
    hex: "#2E6B6B",
    light: "#2E6B6B",
    dark: "#2E6B6B",
    eyeColor: "#F6F3EC",
  },
  {
    id: "ochre",
    name: "Ochre",
    hex: "#7F621B",
    light: "#7F621B",
    dark: "#7F621B",
    eyeColor: "#F6F3EC",
  },
  {
    id: "slate",
    name: "Slate",
    hex: "#5A5F66",
    light: "#5A5F66",
    dark: "#5A5F66",
    eyeColor: "#F6F3EC",
  },
];

export const GROK_BOT_COLORS = GROK_COLOR_LIST.map((c) => c.hex);

export const DEFAULT_GROK_BOT_COLOR = GROK_COLOR_LIST.find((color) => color.id === "indigo")!.hex;

export function shippedHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function shippedRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 1831565813) | 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

const OLD_COLOR_MAP: Record<string, string> = {
  white: "#FFFFFF",
  violet: "#8B5CF6",
  green: "#10B981",
  orange: "#F97316",
  cyan: "#06B6D4",
  blue: "#3B82F6",
  yellow: "#EAB308",
  brown: "#8D6E63",
  red: "#EF4444",
  magenta: "#EC4899",
  gray: "#64748B",
};

/**
 * Bots created before the pigment palette shipped carry these exact hexes from
 * the old round-robin assignment. Nearest-pigment snapping collapses them onto
 * only 4 of the 8 pigments, so they get an explicit 1:1 mapping that preserves
 * the spread those bots already had. Keep every value distinct.
 */
const LEGACY_BOT_COLOR_PIGMENTS: Record<string, string> = {
  "#3ec5a8": "teal",
  "#f5a03c": "ochre",
  "#6a6bf5": "indigo",
  "#9b5cf6": "plum",
  "#3b82f6": "slate",
  "#f2622a": "persimmon",
  "#d9508a": "bengara",
};

export function resolvePersonaColorDef(
  identity: string,
  explicitColor?: string | null,
): GrokColorDef {
  if (explicitColor) {
    const clean = explicitColor.toLowerCase();
    const foundById = GROK_COLOR_LIST.find((c) => c.id === clean || c.name.toLowerCase() === clean);
    if (foundById) return foundById;
    const foundByHex = GROK_COLOR_LIST.find((c) => c.hex.toLowerCase() === clean);
    if (foundByHex) return foundByHex;

    let hexToMatch = clean;
    if (OLD_COLOR_MAP[clean]) {
      hexToMatch = OLD_COLOR_MAP[clean]!;
    }

    const legacyPigmentId = LEGACY_BOT_COLOR_PIGMENTS[hexToMatch];
    if (legacyPigmentId) {
      const mapped = GROK_COLOR_LIST.find((c) => c.id === legacyPigmentId);
      if (mapped) return mapped;
    }

    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hexToMatch)) {
      return getNearestPigment(hexToMatch);
    }
  }
  const seed = (shippedHash(identity) ^ Math.imul(1, 2654435769)) >>> 0;
  const index = Math.floor(shippedRandom((seed ^ 2654435769) >>> 0)() * GROK_COLOR_LIST.length);
  return GROK_COLOR_LIST[index % GROK_COLOR_LIST.length] ?? GROK_COLOR_LIST[0]!;
}

function expandHex(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length === 3) {
    const r = c[0] ?? "0";
    const g = c[1] ?? "0";
    const b = c[2] ?? "0";
    return `${r}${r}${g}${g}${b}${b}`;
  }
  return c;
}

function hexToRgb(hex: string) {
  const c = expandHex(hex);
  return {
    r: Number.parseInt(c.substring(0, 2), 16) || 0,
    g: Number.parseInt(c.substring(2, 4), 16) || 0,
    b: Number.parseInt(c.substring(4, 6), 16) || 0,
  };
}

function colorDistance(hex1: string, hex2: string) {
  const c1 = hexToRgb(hex1);
  const c2 = hexToRgb(hex2);
  return (c1.r - c2.r) ** 2 + (c1.g - c2.g) ** 2 + (c1.b - c2.b) ** 2;
}

function getNearestPigment(hex: string): GrokColorDef {
  let best = GROK_COLOR_LIST[0]!;
  let minDist = Infinity;
  for (const pigment of GROK_COLOR_LIST) {
    const dist = colorDistance(hex, pigment.hex);
    if (dist < minDist) {
      minDist = dist;
      best = pigment;
    }
  }
  return best;
}
