import type { GrokColorDef, SealPhase } from "@ardurbot/core";
import {
  avatarIdentitySeed,
  avatarInitial,
  DEFAULT_GROK_BOT_COLOR,
  deriveSealPhase,
  GROK_BOT_COLORS,
  GROK_COLOR_LIST,
  organicAvatarPath,
  resolvePersonaColorDef,
  SEAL_PICTURE_BANDS,
  SHIPPED_BOT_AVATAR_CENTER,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  SHIPPED_BOT_AVATAR_SHAPES,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  sealInitial,
  sealLayers,
  sealMotions,
  shippedBotAvatarShapePath,
  shippedHash,
} from "@ardurbot/core";
import { tokens } from "@ardurbot/ui-tokens";
import type { CSSProperties } from "react";
import { memo, useMemo } from "react";
import type { AvatarStyle } from "./avatar-style.js";
import { useAvatarStyle } from "./avatar-style.js";
import { cn } from "./lib/utils.js";
import {
  SealLayers,
  sealWebColors,
  usePauseOffscreen,
  useReducedMotion,
  useSealScenePack,
} from "./seal-scene.js";
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
  /** What the bot is doing; takes precedence over `status`. */
  phase?: SealPhase;
  /** A run status, mapped to a phase when `phase` is not given. */
  status?: string;
  /** Draws the phase's still pose even when motion is allowed. */
  still?: boolean;
  identity?: string;
  /** Display name used for the seal initial; identity stays the hash seed. */
  label?: string;
  className?: string;
  variant?: AvatarStyle;
}

/** The four states the avatar exposed before phases, kept for styling hooks and tests. */
const AVATAR_STATUS: Record<SealPhase, "running" | "waiting" | "paused" | "idle"> = {
  idle: "idle",
  starting: "running",
  thinking: "running",
  searching: "running",
  steps: "running",
  waiting: "waiting",
  paused: "paused",
  done: "idle",
  error: "idle",
};

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 36,
  phase: phaseProp,
  status,
  still = false,
  identity = "",
  label,
  className,
  variant,
}: BotAvatarProps) {
  const phase = phaseProp ?? deriveSealPhase({ status }).phase;
  const avatarStatus = AVATAR_STATUS[phase];

  const preferredVariant = useAvatarStyle();
  const pack = useSealScenePack();
  const reducedMotion = useReducedMotion();

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

  const initial = avatarInitial(label ?? effectiveId);
  const organic = parsed.shapeIndex === undefined && (variant ?? preferredVariant) === "organic";
  // A chosen picture keeps its pigment edge and shows only the ring and badge bands.
  const picture = Boolean(parsed.isImage && parsed.imageUrl) || parsed.shapeIndex !== undefined;
  const layers = organic
    ? []
    : sealLayers(pack, phase, size, picture ? SEAL_PICTURE_BANDS : undefined);
  const moving = !still && !reducedMotion && layers.some((layer) => sealMotions(layer).length > 0);
  const rootRef = usePauseOffscreen(moving);
  const colors = sealWebColors(colorDef.hex);
  const scene = (bands: readonly string[], inset?: number) => {
    const drawn = layers.filter((layer) => bands.includes(layer.band));
    return drawn.length > 0 ? (
      <SealLayers
        pack={pack}
        phase={phase}
        layers={drawn}
        size={size}
        colors={colors}
        moving={moving}
        inset={inset}
      />
    ) : null;
  };

  // Ink & Seal: under 28 px the edge is a true circle.
  const sealRadius = size < 28 ? "50%" : "50% 48% 52% 50% / 49% 51% 49% 51%";

  if (parsed.isImage && parsed.imageUrl) {
    return (
      <div
        ref={rootRef}
        className={cn(
          "ardurbot-bot-avatar relative flex shrink-0 select-none items-center justify-center bg-secondary",
          className,
        )}
        aria-hidden="true"
        data-status={avatarStatus}
        data-phase={phase}
        style={{
          width: size,
          height: size,
          borderRadius: sealRadius,
          borderColor: colorDef.hex,
          borderWidth: 2,
          borderStyle: "solid",
        }}
      >
        <img
          src={parsed.imageUrl}
          alt=""
          className="h-full w-full object-cover"
          style={{ borderRadius: sealRadius }}
        />
        {scene(SEAL_PICTURE_BANDS, 2)}
      </div>
    );
  }

  // Active Organic variant
  if (organic) {
    return (
      <OrganicAvatar
        color={colorDef.hex}
        identity={effectiveId}
        size={size}
        isWorking={avatarStatus !== "idle"}
        avatarStatus={avatarStatus}
        className={className}
      />
    );
  }

  // Mascot Silhouette variant
  if (parsed.shapeIndex !== undefined) {
    return (
      <div
        ref={rootRef}
        className={cn(
          "ardurbot-bot-avatar relative flex shrink-0 select-none items-center justify-center bg-card",
          className,
        )}
        aria-hidden="true"
        data-status={avatarStatus}
        data-phase={phase}
        style={{
          width: size,
          height: size,
          borderRadius: sealRadius,
          borderColor: colorDef.hex,
          borderWidth: 2,
          borderStyle: "solid",
        }}
      >
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
        {scene(SEAL_PICTURE_BANDS, 2)}
      </div>
    );
  }

  // Default seal: the pigment disc and initial, with the phase's scene around the initial.
  const initialRule = sealInitial(size);
  return (
    <div
      ref={rootRef}
      className={cn(
        "ardurbot-bot-avatar relative flex shrink-0 select-none items-center justify-center",
        className,
      )}
      aria-hidden="true"
      data-status={avatarStatus}
      data-phase={phase}
      style={{
        width: size,
        height: size,
        borderRadius: sealRadius,
        background: colorDef.hex,
        color: colorDef.eyeColor,
        fontFamily: "'Instrument Serif', Georgia, serif",
        fontStyle: "italic",
        fontSize: Math.round((size * initialRule.size) / 100),
      }}
    >
      {scene(["disc", "scene"])}
      <span
        className="relative"
        style={{ transform: `translateY(${((initialRule.y - 50) * size) / 100}px)` }}
      >
        {initial}
      </span>
      {scene(["ring", "badge"])}
    </div>
  );
});

function OrganicAvatar({
  color,
  identity,
  size,
  isWorking,
  avatarStatus,
  className,
}: {
  color: string;
  identity?: string;
  size: number;
  isWorking: boolean;
  avatarStatus: string;
  className?: string;
}) {
  const reducedMotion = useReducedMotion();
  const seed = avatarIdentitySeed(identity || color || DEFAULT_GROK_BOT_COLOR);
  const duration = `${4.8 + (seed % 24) / 10}s`;
  const shapeA = organicAvatarPath(seed);
  const shapeB = organicAvatarPath(seed, 0.42);

  return (
    <svg
      viewBox="-60 -60 120 120"
      aria-hidden="true"
      className={cn("ardurbot-organic-avatar overflow-visible select-none", className)}
      data-status={avatarStatus}
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

export function GrokShapePreview({
  shapeIndex,
  color,
  selected,
  onClick,
  identity,
  label,
}: {
  shapeIndex: number;
  color: string;
  selected?: boolean;
  onClick?: () => void;
  identity?: string;
  label?: string;
}) {
  const colorDef = resolvePersonaColorDef("preview", color);
  const effectiveId = identity || color || "agent";
  const initial = avatarInitial(label ?? effectiveId);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        shapeIndex === -1
          ? "Seal"
          : (SHIPPED_SHAPE_KEYS[shapeIndex % SHIPPED_SHAPE_KEYS.length] ?? "hex")
      }
      aria-pressed={selected ?? false}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-popover bg-white/10"
          : "hover:bg-white/5",
      )}
    >
      {shapeIndex === -1 ? (
        <div
          className="flex items-center justify-center"
          style={{
            width: 32,
            height: 32,
            borderRadius: "50% 48% 52% 50% / 49% 51% 49% 51%",
            background: colorDef.hex,
            color: colorDef.eyeColor,
            fontFamily: "'Instrument Serif', Georgia, serif",
            fontStyle: "italic",
            fontSize: 19,
          }}
        >
          {initial}
        </div>
      ) : (
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
            <path d={shippedBotAvatarShapePath(shapeIndex)} fill={colorDef.hex} />
            <g fill={colorDef.eyeColor}>
              <ellipse cx={CENTER - 29} cy={CENTER - 8} rx={10} ry={7} />
              <ellipse cx={CENTER + 29} cy={CENTER - 8} rx={10} ry={7} />
            </g>
          </svg>
        </div>
      )}
    </button>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-[34px]", className)}>
      <svg
        viewBox="0 0 400 400"
        className="size-[34px] text-foreground"
        aria-hidden="true"
        fill="none"
      >
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="36"
          strokeLinecap="round"
          d="M 322 100 A 150 150 0 1 0 334 296"
        />
        <rect x="322" y="118" width="40" height="232" rx="20" fill="currentColor" />
      </svg>
      <span className="font-serif text-[34px] leading-none tracking-[-0.02em] text-foreground">
        Ardur
      </span>
    </div>
  );
}
