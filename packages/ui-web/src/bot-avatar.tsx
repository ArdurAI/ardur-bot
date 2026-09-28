import type { GrokColorDef } from "@ardurbot/core";
import {
  ACTIVE_RUN_STATUSES,
  avatarIdentitySeed,
  DEFAULT_GROK_BOT_COLOR,
  GROK_BOT_COLORS,
  GROK_COLOR_LIST,
  organicAvatarPath,
  resolvePersonaColorDef,
  SHIPPED_BOT_AVATAR_CENTER,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  SHIPPED_BOT_AVATAR_SHAPES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  shippedBotAvatarShapePath,
  shippedHash,
} from "@ardurbot/core";
import { tokens } from "@ardurbot/ui-tokens";
import type { CSSProperties } from "react";
import { memo, useId, useMemo, useSyncExternalStore } from "react";
import type { AvatarStyle } from "./avatar-style.js";
import { useAvatarStyle } from "./avatar-style.js";
import { cn } from "./lib/utils.js";
import "./styles.css";

export type { GrokColorDef };
export { DEFAULT_GROK_BOT_COLOR, GROK_BOT_COLORS, GROK_COLOR_LIST, resolvePersonaColorDef };

export const GROK_SHAPES = SHIPPED_BOT_AVATAR_SHAPES;
export const SHIPPED_SHAPE_KEYS = SHIPPED_BOT_AVATAR_SHAPE_KEYS;
const VIEWBOX = SHIPPED_BOT_AVATAR_VIEWBOX;
const CENTER = SHIPPED_BOT_AVATAR_CENTER;

export const GROK_MASCOT_SHAPES = SHIPPED_SHAPE_KEYS.map(
  (k) => GROK_SHAPES[k] ?? FALLBACK_SHAPE_PATH,
);

const FALLBACK_SHAPE_PATH = GROK_SHAPES.hex ?? "";

export function resolvePersonaShape(identity: string, explicitShape?: string | null): string {
  if (explicitShape) {
    const explicit = GROK_SHAPES[explicitShape];
    if (explicit) return explicit;
  }
  let hash = shippedHash(identity);
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  const shapeIndex = ((hash ^ (hash >>> 16)) >>> 0) % SHIPPED_SHAPE_KEYS.length;
  const key = SHIPPED_SHAPE_KEYS[shapeIndex] ?? "hex";
  return GROK_SHAPES[key] ?? FALLBACK_SHAPE_PATH;
}

export function parseBotAvatar(
  rawColor: string,
  _identity?: string,
): {
  color: string;
  shapeIndex?: number;
  isImage: boolean;
  imageUrl?: string;
} {
  if (!rawColor) return { color: "#F97316", isImage: false };
  // Only data: image URLs are rendered. Arbitrary http(s)/blob values in `color`
  // must not become <img src> (SSRF / tracking when other members view the bot).
  if (rawColor.startsWith("data:image/")) {
    return { color: "#F97316", isImage: true, imageUrl: rawColor };
  }
  if (rawColor.includes("::shape_")) {
    const parts = rawColor.split("::shape_");
    const rawShapeIdx = parts[1] ?? "0";
    const parsedShapeIdx = /^\d+$/.test(rawShapeIdx) ? Number(rawShapeIdx) : 0;
    const shapeIdx = Number.isSafeInteger(parsedShapeIdx) ? parsedShapeIdx : 0;
    return {
      color: parts[0] || "#F97316",
      shapeIndex: shapeIdx % SHIPPED_SHAPE_KEYS.length,
      isImage: false,
    };
  }
  return { color: rawColor, isImage: false };
}

export interface BotAvatarProps {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  className?: string;
  variant?: AvatarStyle;
}

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 36,
  status,
  identity = "",
  className,
  variant,
}: BotAvatarProps) {
  const id = useId().replace(/[^a-zA-Z0-9-_]/g, "");
  const isWorking = ACTIVE_RUN_STATUSES.some((s) => s === status);
  const preferredVariant = useAvatarStyle();

  const parsed = useMemo(() => parseBotAvatar(color, identity), [color, identity]);
  const effectiveId = identity || parsed.color || "agent";

  const colorDef = useMemo(
    () => resolvePersonaColorDef(effectiveId, parsed.color),
    [effectiveId, parsed.color],
  );

  const shapePath = useMemo(() => {
    if (parsed.shapeIndex !== undefined) {
      return shippedBotAvatarShapePath(parsed.shapeIndex);
    }
    return resolvePersonaShape(effectiveId);
  }, [parsed.shapeIndex, effectiveId]);

  if (parsed.isImage && parsed.imageUrl) {
    return (
      <div
        className={cn(
          "ardurbot-bot-avatar relative overflow-hidden rounded-full flex items-center justify-center select-none bg-secondary shrink-0 border border-border",
          className,
        )}
        data-working={isWorking}
        style={{
          width: size,
          height: size,
          boxShadow: isWorking
            ? "0 0 0 2px #3B82F6, 0 0 10px rgba(59,130,246,0.6)"
            : "0 2px 5px rgba(0,0,0,0.5)",
        }}
      >
        {isWorking ? (
          <svg
            className="ardurbot-bot-avatar-ring absolute pointer-events-none"
            style={{
              inset: -4,
              width: size + 8,
              height: size + 8,
            }}
            viewBox="0 0 48 48"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="24"
              cy="24"
              r="22"
              stroke="#3B82F6"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeDasharray="45 80"
            />
          </svg>
        ) : null}
        <img src={parsed.imageUrl} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }

  if (parsed.shapeIndex === undefined && (variant ?? preferredVariant) === "organic") {
    return (
      <OrganicAvatar
        color={colorDef.hex}
        identity={effectiveId}
        size={size}
        isWorking={isWorking}
        className={className}
      />
    );
  }

  return (
    <div
      className={cn(
        "ardurbot-bot-avatar grok-avatar-container relative inline-flex items-center justify-center shrink-0 select-none",
        className,
      )}
      style={{
        width: size,
        height: size,
      }}
      data-working={isWorking}
    >
      <svg
        className="ardurbot-bot-avatar-ring absolute pointer-events-none"
        style={{
          inset: -4,
          width: size + 8,
          height: size + 8,
          filter: `drop-shadow(0 0 6px ${colorDef.light}) drop-shadow(0 0 10px #ffffff)`,
        }}
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="24"
          cy="24"
          r="22"
          stroke={`url(#${id}-ring)`}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeDasharray="45 80"
        />
        <circle cx="43" cy="24" r="2.8" fill="#ffffff" />
        <defs>
          <linearGradient id={`${id}-ring`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="60%" stopColor={colorDef.light} stopOpacity="0.9" />
            <stop offset="100%" stopColor={colorDef.light} stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      <svg
        viewBox={VIEWBOX}
        width={size}
        height={size}
        aria-hidden="true"
        className={cn(
          "overflow-visible transition-transform duration-300",
          isWorking
            ? "animate-pulse scale-[1.04] motion-reduce:animate-none"
            : "hover:scale-[1.03] motion-reduce:hover:scale-100",
        )}
        style={{
          filter: isWorking
            ? `drop-shadow(0 0 8px ${colorDef.light}) drop-shadow(0 0 2px #ffffff)`
            : "drop-shadow(0 2px 4px rgba(0,0,0,0.45))",
        }}
      >
        <defs>
          <linearGradient id={`grok-ink-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={colorDef.light} />
            <stop offset="100%" stopColor={colorDef.dark} />
          </linearGradient>
        </defs>
        <g>
          <path d={shapePath} fill={`url(#grok-ink-${id})`} />
          <g fill={colorDef.eyeColor} className="grok-character-eyes">
            <ellipse cx={CENTER - 29} cy={CENTER - 8} rx={10} ry={7} />
            <ellipse cx={CENTER + 29} cy={CENTER - 8} rx={10} ry={7} />
          </g>
        </g>
      </svg>
    </div>
  );
});

function OrganicAvatar({
  color,
  identity,
  size,
  isWorking,
  className,
}: {
  color: string;
  identity?: string;
  size: number;
  isWorking: boolean;
  className?: string;
}) {
  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );
  const seed = avatarIdentitySeed(identity || color || DEFAULT_GROK_BOT_COLOR);
  const duration = `${4.8 + (seed % 24) / 10}s`;
  const shapeA = organicAvatarPath(seed);
  const shapeB = organicAvatarPath(seed, 0.42);

  return (
    <svg
      viewBox="-60 -60 120 120"
      aria-hidden="true"
      className={cn("ardurbot-organic-avatar overflow-visible select-none", className)}
      data-working={isWorking}
      data-shape-family={seed % 10}
      data-eye-pattern={seed % 4}
      style={{
        width: size,
        height: size,
        flex: "none",
      }}
    >
      {(["idle", "working"] as const).map((mode) => (
        <path
          key={mode}
          className={`ardurbot-organic-avatar-body ardurbot-organic-avatar-body-${mode}`}
          d={shapeA}
          fill={color}
          style={
            {
              "--ardurbot-organic-path": `path("${shapeA}")`,
              filter:
                mode === "working"
                  ? `drop-shadow(0 0 ${Math.round(size * 0.16)}px ${color})`
                  : "drop-shadow(0 2px 3px rgba(0,0,0,.34))",
            } as CSSProperties
          }
        >
          {!reducedMotion ? (
            <animate
              attributeName="d"
              values={`${shapeA};${shapeB};${shapeA}`}
              dur={duration}
              repeatCount="indefinite"
            />
          ) : null}
        </path>
      ))}
      <g transform={`rotate(${(seed % 9) - 4})`}>
        {(["idle", "working"] as const).map((mode) => (
          <g
            key={mode}
            className={`ardurbot-organic-avatar-eyes ardurbot-organic-avatar-eyes-${mode}`}
            fill={tokens.background}
          >
            <rect x="-14" y="-12" width="7" height="24" rx="3.5" />
            <rect x="7" y="-12" width="7" height="24" rx="3.5" />
          </g>
        ))}
      </g>
    </svg>
  );
}

const reducedMotionMedia = "(prefers-reduced-motion: reduce)";

function reducedMotionSnapshot(): boolean {
  return window.matchMedia(reducedMotionMedia).matches;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const media = window.matchMedia(reducedMotionMedia);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function GrokShapePreview({
  shapeIndex,
  color,
  selected,
  onClick,
}: {
  shapeIndex: number;
  color: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const key = SHIPPED_SHAPE_KEYS[shapeIndex % SHIPPED_SHAPE_KEYS.length] ?? "hex";
  const path = shippedBotAvatarShapePath(shapeIndex);
  const colorDef = resolvePersonaColorDef("preview", color);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={key}
      aria-pressed={selected ?? false}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-popover bg-white/10"
          : "hover:bg-white/5",
      )}
    >
      <svg viewBox={VIEWBOX} className="size-8 overflow-visible" aria-hidden="true">
        <path d={path} fill={colorDef.light} />
        <g fill={colorDef.eyeColor}>
          <ellipse cx={CENTER - 29} cy={CENTER - 8} rx={10} ry={7} />
          <ellipse cx={CENTER + 29} cy={CENTER - 8} rx={10} ry={7} />
        </g>
      </svg>
    </button>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <svg
        viewBox="0 0 400 400"
        className="h-[34px] w-[34px] text-foreground"
        aria-hidden="true"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          fill="currentColor"
          d="M298 74.5L306.6 78.9L314.9 83.9L322.8 89.6L330.4 96L337.5 102.9L343.9 110.5L348.9 119.1L353.2 128L357 137.2L360.1 146.5L362.8 156.1L364.8 165.7L366.4 175.4L367.4 185.2L367.9 195.1L367.9 204.9L367.4 214.7L366.4 224.5L364.9 234.2L362.8 243.9L360.2 253.4L357 262.8L353.2 271.9L348.7 280.8L343.7 289.3L338 297.4L331.8 305.1L325 312.3L317.8 318.9L310 324.9L301.9 330.4L293.5 335.2L284.8 339.4L275.9 343L266.9 346.1L257.8 348.6L248.6 350.6L239.5 352.2L230.3 353.3L221.2 354.1L212.1 354.5L203 354.5L194 354.3L185 353.6L176 352.7L167 351.3L158.1 349.6L149.3 347.4L140.5 344.7L131.8 341.6L123.4 337.9L115.1 333.7L107.1 328.9L99.4 323.6L92.1 317.8L85.2 311.5L78.7 304.7L72.7 297.5L67.2 289.9L62.1 282L57.6 273.8L53.5 265.3L49.9 256.7L46.7 247.8L44 238.8L41.7 229.7L39.8 220.4L38.3 211.1L37.3 201.6L37.4 192.1L38.1 182.6L39.3 173.1L41 163.7L43.3 154.4L46.1 145.3L49.6 136.4L53.6 127.7L58.2 119.4L63.5 111.4L69.4 103.9L75.7 96.9L82.6 90.4L90 84.5L97.7 79.2L105.8 74.5L114.1 70.4L122.6 66.9L131.2 63.9L139.8 61.5L148.5 59.5L157.2 58L165.9 56.9L174.5 56.1L183 55.5L191.5 55.1L200 55.2L200 56.4L191.6 56.3L183.1 56.6L174.7 57.3L166.3 58.5L157.9 60.3L149.6 62.5L141.4 65.1L133.4 68.3L125.5 71.9L117.9 76.1L110.6 80.8L103.6 86.1L97 91.9L91 98.2L85.4 104.9L80.5 112.1L76.1 119.6L72.4 127.4L69.3 135.5L66.9 143.7L65 152L63.8 160.4L63.1 168.8L62.9 177.1L63.2 185.3L63.9 193.4L64.9 201.3L65.6 209.2L66.6 217L68 224.8L69.7 232.4L71.7 240L74.2 247.5L77 254.9L80.3 262L84 269L88.1 275.8L92.7 282.2L97.7 288.3L103.2 294.1L109 299.4L115.2 304.2L121.7 308.6L128.6 312.5L135.6 315.9L142.8 318.8L150.2 321.2L157.6 323.2L165.1 324.7L172.6 325.9L180.1 326.7L187.6 327.2L195 327.5L202.5 327.5L210 327.2L217.4 326.6L224.9 325.8L232.3 324.7L239.8 323.2L247.2 321.4L254.6 319.2L261.9 316.6L269.1 313.5L276.1 310L282.8 305.9L289.3 301.4L295.4 296.3L301.1 290.8L306.4 284.9L311.3 278.5L315.6 271.8L319.4 264.8L322.7 257.6L325.5 250.2L327.9 242.6L329.7 235L331.1 227.2L332.2 219.5L332.8 211.7L333.1 203.9L333 196.1L332.5 188.3L331.7 180.6L330.6 172.8L329 165.2L327.1 157.6L324.7 150.1L321.8 142.8L318.5 135.6L314.7 128.6L311.3 121.4L307.5 114.2L303.2 107.3L298.3 100.7L292.9 94.5L286.9 88.7Z"
        />
      </svg>
      <span
        className="font-['Instrument_Serif',Georgia,serif] text-[34px] tracking-tight text-foreground leading-none"
        style={{ letterSpacing: "-0.02em" }}
      >
        Ardur
      </span>
    </div>
  );
}
