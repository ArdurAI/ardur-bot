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
  const isRunning = status === "running" || status === "queued" || status === "leased";
  const isWaiting = status === "waiting_input";
  const isPaused = status === "waiting_takeover";

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

  const initial = (effectiveId || "A")[0]!.toUpperCase();

  const reducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false,
  );

  // Determine standard seal styles
  const sealRadius = size < 28 ? "50%" : "50% 48% 52% 50% / 49% 51% 49% 51%";

  if (parsed.isImage && parsed.imageUrl) {
    return (
      <div
        className={cn(
          "ardurbot-bot-avatar relative flex shrink-0 select-none items-center justify-center bg-secondary",
          className,
        )}
        style={{
          width: size,
          height: size,
          borderRadius: sealRadius,
          borderColor: colorDef.hex,
          borderWidth: 2,
          borderStyle: "solid",
        }}
      >
        {isRunning ? (
          <svg
            className={cn("absolute pointer-events-none", !reducedMotion && "animate-spin")}
            style={{ width: size + 8, height: size + 8, inset: -6, animationDuration: "3s" }}
            viewBox="0 0 56 56"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="28"
              cy="28"
              r="26"
              stroke="var(--foreground)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={reducedMotion ? "none" : "122 41"}
              transform="rotate(-60 28 28)"
            />
          </svg>
        ) : null}
        {isWaiting && (
          <div
            className="absolute top-0 right-0 rounded-full"
            style={{
              width: Math.max(8, size * 0.3),
              height: Math.max(8, size * 0.3),
              background: "var(--warning)",
              border: "3px solid var(--background)",
              transform: "translate(20%, -20%)",
            }}
          />
        )}
        <img
          src={parsed.imageUrl}
          alt=""
          className="h-full w-full object-cover"
          style={{ borderRadius: sealRadius }}
        />
      </div>
    );
  }

  // Active Organic variant
  if (parsed.shapeIndex === undefined && (variant ?? preferredVariant) === "organic") {
    return (
      <OrganicAvatar
        color={colorDef.hex}
        identity={effectiveId}
        size={size}
        isWorking={isRunning || isWaiting || isPaused}
        className={className}
      />
    );
  }

  // Mascot Silhouette variant
  if (parsed.shapeIndex !== undefined) {
    return (
      <div
        className={cn(
          "ardurbot-bot-avatar relative flex shrink-0 select-none items-center justify-center bg-card",
          className,
        )}
        style={{
          width: size,
          height: size,
          borderRadius: sealRadius,
          borderColor: colorDef.hex,
          borderWidth: 2,
          borderStyle: "solid",
        }}
      >
        {isRunning ? (
          <svg
            className={cn("absolute pointer-events-none", !reducedMotion && "animate-spin")}
            style={{ width: size + 8, height: size + 8, inset: -6, animationDuration: "3s" }}
            viewBox="0 0 56 56"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="28"
              cy="28"
              r="26"
              stroke="var(--foreground)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={reducedMotion ? "none" : "122 41"}
              transform="rotate(-60 28 28)"
            />
          </svg>
        ) : null}
        {isWaiting && (
          <div
            className="absolute top-0 right-0 rounded-full"
            style={{
              width: Math.max(8, size * 0.3),
              height: Math.max(8, size * 0.3),
              background: "var(--warning)",
              border: "3px solid var(--background)",
              transform: "translate(20%, -20%)",
            }}
          />
        )}
        <svg
          viewBox={VIEWBOX}
          width={size * 0.8}
          height={size * 0.8}
          aria-hidden="true"
          className="overflow-visible"
        >
          <path d={shapePath} fill={colorDef.hex} />
          <g fill={colorDef.eyeColor} className="grok-character-eyes">
            <ellipse cx={CENTER - 29} cy={CENTER - 8} rx={10} ry={7} />
            <ellipse cx={CENTER + 29} cy={CENTER - 8} rx={10} ry={7} />
          </g>
        </svg>
      </div>
    );
  }

  // Default Seal with Initial
  return (
    <div
      className={cn(
        "ardurbot-bot-avatar relative flex shrink-0 select-none items-center justify-center",
        className,
      )}
      style={{
        width: isRunning ? size * 0.8 : size,
        height: isRunning ? size * 0.8 : size,
        borderRadius: sealRadius,
        background: isPaused ? "transparent" : colorDef.hex,
        border: isPaused ? `2px dashed ${colorDef.hex}` : "none",
        color: isPaused ? "var(--muted-foreground)" : colorDef.eyeColor,
        fontFamily: "'Instrument Serif', Georgia, serif",
        fontStyle: "italic",
        fontSize: Math.round((isRunning ? size * 0.8 : size) * 0.6),
        boxSizing: "border-box",
        margin: isRunning ? size * 0.1 : 0,
      }}
    >
      {isRunning ? (
        <svg
          className={cn("absolute pointer-events-none", !reducedMotion && "animate-spin")}
          style={{ width: size + 8, height: size + 8, animationDuration: "3s" }}
          viewBox="0 0 56 56"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="28"
            cy="28"
            r="26"
            stroke="var(--foreground)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={reducedMotion ? "none" : "122 41"}
            transform="rotate(-60 28 28)"
          />
        </svg>
      ) : null}

      {initial}

      {isWaiting && (
        <div
          className="absolute top-0 right-0 rounded-full"
          style={{
            width: Math.max(8, size * 0.3),
            height: Math.max(8, size * 0.3),
            background: "var(--warning)",
            border: "3px solid var(--background)",
            transform: "translate(20%, -20%)",
          }}
        />
      )}
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
      <div
        className="flex items-center justify-center bg-card"
        style={{
          width: 32,
          height: 32,
          borderRadius: "50% 48% 52% 50% / 49% 51% 49% 51%",
          borderColor: colorDef.hex,
          borderWidth: 2,
          borderStyle: "solid",
        }}
      >
        <svg viewBox={VIEWBOX} className="size-6 overflow-visible" aria-hidden="true">
          <path d={path} fill={colorDef.hex} />
          <g fill={colorDef.eyeColor}>
            <ellipse cx={CENTER - 29} cy={CENTER - 8} rx={10} ry={7} />
            <ellipse cx={CENTER + 29} cy={CENTER - 8} rx={10} ry={7} />
          </g>
        </svg>
      </div>
    </button>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      <span className="font-serif text-[26px] tracking-tight text-foreground">Ardur</span>
    </div>
  );
}
