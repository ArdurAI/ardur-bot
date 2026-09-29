import type {
  SealBand,
  SealLayer,
  SealMotion,
  SealPaint,
  SealPhase,
  SealScenePack,
  SealStrokeWidth,
} from "./types.js";
import {
  SEAL_BANDS,
  SEAL_INITIAL,
  SEAL_LARGE_FROM,
  SEAL_STROKE_WIDTHS,
  SEAL_TRANSFORM_PROPERTIES,
} from "./types.js";

/** Colours a renderer resolves for each paint token. */
export type SealColors = Readonly<Record<SealPaint, string>>;

/** Image and mascot avatars keep their picture and draw only these bands. */
export const SEAL_PICTURE_BANDS = ["ring", "badge"] as const satisfies readonly SealBand[];

export function isLargeSeal(size: number): boolean {
  return size >= SEAL_LARGE_FROM;
}

/** The layers a seal of this size draws, bottom to top, limited to `bands`. */
export function sealLayers(
  pack: SealScenePack,
  phase: SealPhase,
  size: number,
  bands: readonly SealBand[] = SEAL_BANDS,
): SealLayer[] {
  const large = isLargeSeal(size);
  const layers = pack.phases[phase].layers.filter(
    (layer) => layer.sizes === "all" || (layer.sizes === "large") === large,
  );
  return SEAL_BANDS.filter((band) => bands.includes(band)).flatMap((band) =>
    layers.filter((layer) => layer.band === band),
  );
}

export function sealInitial(size: number): { size: number; y: number } {
  return isLargeSeal(size) ? SEAL_INITIAL.large : SEAL_INITIAL.small;
}

export function sealStrokeWidth(width: SealStrokeWidth, size: number): number {
  if (typeof width === "number") return width;
  return SEAL_STROKE_WIDTHS[width][isLargeSeal(size) ? "large" : "small"];
}

export function sealMotions(layer: SealLayer): readonly SealMotion[] {
  if (!layer.motion) return [];
  return "property" in layer.motion ? [layer.motion] : layer.motion;
}

export function isSealTransformMotion(motion: SealMotion): boolean {
  return (SEAL_TRANSFORM_PROPERTIES as readonly string[]).includes(motion.property);
}

export interface SealPaintProps {
  fill: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  strokeLinecap?: "round" | "butt";
  strokeDasharray?: string;
  strokeDashoffset?: number;
  opacity?: number;
  transform?: string;
}

/** A layer's still pose as SVG attributes, named as React props for web and native SVG. */
export type SealElementProps =
  | ({ element: "circle"; cx: number; cy: number; r: number } & SealPaintProps)
  | ({ element: "path"; d: string } & SealPaintProps)
  | ({ element: "line"; x1: number; y1: number; x2: number; y2: number } & SealPaintProps)
  | ({
      element: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
    } & SealPaintProps);

export function sealStillProps(
  layer: SealLayer,
  size: number,
  colors: SealColors,
): SealElementProps {
  const { fill, stroke } = layer;
  const paint: SealPaintProps = {
    // Native SVG fills unpainted shapes black, so "none" is always explicit.
    fill: fill ? colors[fill.paint] : "none",
    ...(fill?.opacity !== undefined ? { fillOpacity: fill.opacity } : {}),
    ...(stroke
      ? {
          stroke: colors[stroke.paint],
          strokeWidth: sealStrokeWidth(stroke.width, size),
          ...(stroke.opacity !== undefined ? { strokeOpacity: stroke.opacity } : {}),
          ...(stroke.linecap ? { strokeLinecap: stroke.linecap } : {}),
          ...(stroke.dasharray ? { strokeDasharray: stroke.dasharray.join(" ") } : {}),
          ...(stroke.dashoffset !== undefined ? { strokeDashoffset: stroke.dashoffset } : {}),
        }
      : {}),
    ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
    ...(layer.rotate !== undefined ? { transform: `rotate(${layer.rotate} 50 50)` } : {}),
  };
  const { shape } = layer;
  switch (shape.kind) {
    case "circle":
      return { element: "circle", cx: shape.cx, cy: shape.cy, r: shape.r, ...paint };
    case "path":
      return { element: "path", d: shape.d, ...paint };
    case "line":
      return { element: "line", x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2, ...paint };
    case "rect":
      return {
        element: "rect",
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        ...(shape.rx !== undefined ? { rx: shape.rx } : {}),
        ...paint,
      };
  }
}
