/**
 * Seal scenes: how a bot's seal looks and moves in each phase, as data. A pack
 * gives every phase a label and a list of layers drawn in a 100×100 viewBox on
 * the seal's pigment disc. Renderers draw the layers; they hold no scene
 * knowledge. See docs/seal-scenes.md.
 */

export const SEAL_PHASES = [
  "idle",
  "starting",
  "thinking",
  "searching",
  "steps",
  "waiting",
  "paused",
  "done",
  "error",
] as const;
export type SealPhase = (typeof SEAL_PHASES)[number];

/** How far a bot is through its current plan or task list. */
export interface SealProgress {
  done: number;
  total: number;
}

/**
 * Paint tokens. `pigment` is the bot's colour; `paper` and `ink` are the Ink &
 * Seal paper and ink, the same in both themes; `attention` is the theme's
 * warning colour.
 */
export const SEAL_PAINTS = ["pigment", "paper", "ink", "attention"] as const;
export type SealPaint = (typeof SEAL_PAINTS)[number];

/**
 * Z-order, bottom to top. The renderer draws the bot's initial between the
 * scene and ring bands.
 */
export const SEAL_BANDS = ["disc", "scene", "ring", "badge"] as const;
export type SealBand = (typeof SEAL_BANDS)[number];

/** `large` layers draw from {@link SEAL_LARGE_FROM} px up; `small` layers below it. */
export type SealLayerSizes = "all" | "large" | "small";

/** Named stroke widths resolve per size through {@link SEAL_STROKE_WIDTHS}. */
export type SealStrokeWidth = number | "ring" | "thin";

export const SEAL_MOTION_PROPERTIES = [
  "rotate",
  "translateX",
  "translateY",
  "scale",
  "opacity",
  "strokeOpacity",
  "fillOpacity",
  "dashOffset",
] as const;
export type SealMotionProperty = (typeof SEAL_MOTION_PROPERTIES)[number];

/** Properties that move the whole layer; a layer animates at most one of them. */
export const SEAL_TRANSFORM_PROPERTIES = [
  "rotate",
  "translateX",
  "translateY",
  "scale",
] as const satisfies readonly SealMotionProperty[];

/** A CSS easing keyword, or cubic-bezier control points. */
export type SealEasing =
  | "linear"
  | "ease-in-out"
  | "ease-out"
  | readonly [number, number, number, number];

export interface SealKeyframe {
  /** Position in the loop, from 0 to 1. */
  at: number;
  /** Degrees for rotate, viewBox units for translate and dash offset, a factor otherwise. */
  value: number;
}

/**
 * One animated property. Motions loop forever; the easing applies between each
 * pair of keyframes, as in CSS. Before its delay a motion holds its first
 * keyframe.
 */
export interface SealMotion {
  property: SealMotionProperty;
  keyframes: readonly SealKeyframe[];
  durationMs: number;
  easing: SealEasing;
  delayMs?: number;
  direction?: "normal" | "reverse" | "alternate";
  /** Transform origin in the viewBox; the seal's centre when omitted. */
  origin?: readonly [number, number];
}

export type SealShape =
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "path"; d: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number; rx?: number };

export interface SealFill {
  paint: SealPaint;
  opacity?: number;
}

export interface SealStroke {
  paint: SealPaint;
  opacity?: number;
  width: SealStrokeWidth;
  linecap?: "round" | "butt";
  dasharray?: readonly number[];
  dashoffset?: number;
}

/**
 * One drawn shape. Its attributes are the still pose, which is all that shows
 * under reduced motion, so they must read on their own.
 */
export interface SealLayer {
  /** Unique within its phase; names the layer's animation. */
  id: string;
  band: SealBand;
  sizes: SealLayerSizes;
  shape: SealShape;
  fill?: SealFill;
  stroke?: SealStroke;
  opacity?: number;
  /**
   * Still rotation in degrees about the seal's centre. A layer with a still
   * rotation moves only through `rotate`, whose keyframes include the rotation.
   */
  rotate?: number;
  motion?: SealMotion | readonly SealMotion[];
}

export interface SealScene {
  /** English source text of the phase's screen-reader label; apps translate it. */
  labelKey: string;
  layers: readonly SealLayer[];
}

export interface SealScenePack {
  id: string;
  name: string;
  phases: Readonly<Record<SealPhase, SealScene>>;
}

/** Seals this size (px) and up draw their large variant. */
export const SEAL_LARGE_FROM = 40;

export const SEAL_STROKE_WIDTHS = {
  ring: { large: 4, small: 7 },
  thin: { large: 2.5, small: 4 },
} as const;

/** The initial's font size and vertical centre, in viewBox units. */
export const SEAL_INITIAL = {
  large: { size: 48, y: 49 },
  small: { size: 60, y: 52 },
} as const;
