import type {
  SealColors,
  SealEasing,
  SealLayer,
  SealMotion,
  SealMotionProperty,
  SealScenePack,
} from "@ardurbot/core";
import { deriveSealPhase, isSealTransformMotion, sealMotions, sealScenePack } from "@ardurbot/core";
import { sealPaints } from "@ardurbot/ui-tokens";

export type SealCurve = "linear" | readonly [number, number, number, number];

/** A pack easing as a curve Reanimated can play; keywords use the curves CSS defines. */
export function sealCurve(easing: SealEasing): SealCurve {
  if (easing === "ease-in-out") return [0.42, 0, 0.58, 1];
  if (easing === "ease-out") return [0, 0, 0.58, 1];
  return easing;
}

/** The curve played backwards, as CSS does on reverse and alternate passes. */
function reversedCurve(curve: SealCurve): SealCurve {
  if (curve === "linear") return curve;
  const [x1, y1, x2, y2] = curve;
  const flip = (value: number) => Math.round((1 - value) * 1e6) / 1e6;
  return [flip(x2), flip(y2), flip(x1), flip(y1)];
}

export interface SealTimelineStep {
  value: number;
  durationMs: number;
  curve: SealCurve;
}

export interface SealTimeline {
  delayMs: number;
  /** One loop, starting with an instant step to the loop's first value. */
  steps: SealTimelineStep[];
}

/**
 * One loop of a motion as timing steps, played the way CSS plays its keyframes:
 * each step eases to the next keyframe; `reverse` runs them backwards and
 * `alternate` runs forwards then back, so one loop holds both passes.
 */
export function sealTimeline(motion: SealMotion): SealTimeline {
  const { keyframes, durationMs } = motion;
  const curve = sealCurve(motion.easing);
  const span = (from: number, to: number) => Math.round((to - from) * durationMs);
  const forward = keyframes.slice(1).map((keyframe, index) => ({
    value: keyframe.value,
    durationMs: span(keyframes[index]!.at, keyframe.at),
    curve,
  }));
  const backward = keyframes
    .slice(0, -1)
    .map((keyframe, index) => ({
      value: keyframe.value,
      durationMs: span(keyframe.at, keyframes[index + 1]!.at),
      curve: reversedCurve(curve),
    }))
    .reverse();
  const jump = (value: number): SealTimelineStep => ({ value, durationMs: 0, curve: "linear" });
  const first = keyframes[0]!.value;
  const delayMs = motion.delayMs ?? 0;
  switch (motion.direction ?? "normal") {
    case "reverse":
      return { delayMs, steps: [jump(keyframes.at(-1)!.value), ...backward] };
    case "alternate":
      return { delayMs, steps: [jump(first), ...forward, ...backward] };
    case "normal":
      return { delayMs, steps: [jump(first), ...forward] };
  }
}

/** A layer's still value for an animated property: the pose reduced motion shows. */
export function sealStillValue(layer: SealLayer, property: SealMotionProperty): number {
  switch (property) {
    case "opacity":
      return layer.opacity ?? 1;
    case "fillOpacity":
      return layer.fill?.opacity ?? 1;
    case "strokeOpacity":
      return layer.stroke?.opacity ?? 1;
    case "dashOffset":
      return layer.stroke?.dashoffset ?? 0;
    case "rotate":
      return layer.rotate ?? 0;
    case "scale":
      return 1;
    case "translateX":
    case "translateY":
      return 0;
  }
}

export type SealLayerGroup =
  | { kind: "shapes"; layers: SealLayer[] }
  | { kind: "transform"; layer: SealLayer };

/**
 * Layers in drawing order, grouped for native SVG: neighbours share one canvas,
 * and a layer that moves as a whole gets its own view so the transform runs
 * natively.
 */
export function sealLayerGroups(layers: readonly SealLayer[]): SealLayerGroup[] {
  const groups: SealLayerGroup[] = [];
  for (const layer of layers) {
    const last = groups.at(-1);
    if (sealMotions(layer).some(isSealTransformMotion)) groups.push({ kind: "transform", layer });
    else if (last?.kind === "shapes") last.layers.push(layer);
    else groups.push({ kind: "shapes", layers: [layer] });
  }
  return groups;
}

/** Paint for a native seal; the attention dot follows the theme's warning colour. */
export function sealNativeColors(pigment: string, warning: string): SealColors {
  return { pigment, paper: sealPaints.paper, ink: sealPaints.ink, attention: warning };
}

/** The label key a screen reader hears for a busy bot, or null when it rests. */
export function sealPhaseLabelKey(
  status: string | undefined,
  pack: SealScenePack = sealScenePack(),
): string | null {
  const { phase } = deriveSealPhase({ status });
  return phase === "idle" ? null : pack.phases[phase].labelKey;
}
