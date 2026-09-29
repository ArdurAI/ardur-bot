import type { SealEasing, SealMotion, SealPhase, SealScenePack } from "@ardurbot/core";
import { isSealTransformMotion, SEAL_PHASES, sealMotions } from "@ardurbot/core";

/** The class a layer carries while its motion plays. */
export function sealMotionClass(packId: string, phase: SealPhase, layerId: string): string {
  return `ardurbot-seal-${packId}-${phase}-${layerId}`;
}

function cssEasing(easing: SealEasing): string {
  return typeof easing === "string" ? easing : `cubic-bezier(${easing.join(", ")})`;
}

/** Transform lengths are viewBox units, which CSS writes as px inside an SVG. */
function cssDeclaration(motion: SealMotion, value: number): string {
  switch (motion.property) {
    case "rotate":
      return `transform: rotate(${value}deg)`;
    case "translateX":
      return `transform: translateX(${value}px)`;
    case "translateY":
      return `transform: translateY(${value}px)`;
    case "scale":
      return `transform: scale(${value})`;
    case "opacity":
      return `opacity: ${value}`;
    case "strokeOpacity":
      return `stroke-opacity: ${value}`;
    case "fillOpacity":
      return `fill-opacity: ${value}`;
    case "dashOffset":
      return `stroke-dashoffset: ${value}`;
  }
}

function list(motions: readonly SealMotion[], value: (motion: SealMotion) => string): string {
  return motions.map(value).join(", ");
}

/**
 * A pack's motions as CSS: one `@keyframes` per motion and one rule per moving
 * layer. The rules apply only when the reader allows motion, so a seal falls
 * back to its still pose. They set no play state, which leaves pausing free.
 */
export function sealSceneCss(pack: SealScenePack): string {
  const rules: string[] = [];
  const keyframes: string[] = [];
  for (const phase of SEAL_PHASES) {
    for (const layer of pack.phases[phase].layers) {
      const motions = sealMotions(layer);
      if (motions.length === 0) continue;
      const className = sealMotionClass(pack.id, phase, layer.id);
      const names = motions.map((_, index) => `${className}-${index}`);
      motions.forEach((motion, index) => {
        const frames = motion.keyframes
          .map(
            ({ at, value }) =>
              `${Math.round(at * 10_000) / 100}% { ${cssDeclaration(motion, value)} }`,
          )
          .join(" ");
        keyframes.push(`@keyframes ${names[index]} { ${frames} }`);
      });
      const transform = motions.find(isSealTransformMotion);
      const [originX, originY] = transform?.origin ?? [50, 50];
      const declarations = [
        `animation-name: ${names.join(", ")}`,
        `animation-duration: ${list(motions, (motion) => `${motion.durationMs}ms`)}`,
        `animation-timing-function: ${list(motions, (motion) => cssEasing(motion.easing))}`,
        `animation-delay: ${list(motions, (motion) => `${motion.delayMs ?? 0}ms`)}`,
        `animation-direction: ${list(motions, (motion) => motion.direction ?? "normal")}`,
        "animation-iteration-count: infinite",
        "animation-fill-mode: both",
        ...(transform
          ? ["transform-box: view-box", `transform-origin: ${originX}px ${originY}px`]
          : []),
      ];
      rules.push(`:root:not([data-motion="reduced"]) .${className} { ${declarations.join("; ")} }`);
    }
  }
  return [
    `@media (prefers-reduced-motion: no-preference) {\n${rules.join("\n")}\n}`,
    ...keyframes,
  ].join("\n");
}
