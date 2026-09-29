import type { SealMotion } from "@ardurbot/core";
import {
  SEAL_PHASES,
  SEAL_SCENE_PACKS,
  sealLayers,
  sealMotions,
  sealScenePack,
} from "@ardurbot/core";
import { lightTokens } from "@ardurbot/ui-tokens";
import { describe, expect, it } from "vitest";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";
import {
  sealCurve,
  sealLayerGroups,
  sealNativeColors,
  sealPhaseLabelKey,
  sealStillValue,
  sealTimeline,
} from "./seal-scene";

const pack = sealScenePack("landscapes-wonders");
const motionOf = (phase: (typeof SEAL_PHASES)[number], id: string): SealMotion => {
  const layer = pack.phases[phase].layers.find((candidate) => candidate.id === id)!;
  return sealMotions(layer)[0]!;
};

describe("native seal timelines", () => {
  it("plays the sunrise as the canvas does: jump to the start, rise, then hold", () => {
    expect(sealTimeline(motionOf("starting", "sun"))).toEqual({
      delayMs: 0,
      steps: [
        { value: 10, durationMs: 0, curve: "linear" },
        { value: -9, durationMs: 1620, curve: [0.3, 0.7, 0.3, 1] },
        { value: -9, durationMs: 1980, curve: [0.3, 0.7, 0.3, 1] },
      ],
    });
  });

  it("holds the first keyframe through a delay and uses the CSS keyword curves", () => {
    const timeline = sealTimeline(motionOf("steps", "step-2"));
    expect(timeline.delayMs).toBe(800);
    expect(timeline.steps.map((step) => step.durationMs)).toEqual([0, 864, 3072, 864]);
    expect(timeline.steps[1]!.curve).toEqual([0.42, 0, 0.58, 1]);
    expect(sealCurve("ease-out")).toEqual([0, 0, 0.58, 1]);
  });

  it("runs a reverse motion backwards", () => {
    expect(sealTimeline(motionOf("thinking", "aurora-2")).steps).toEqual([
      { value: -36, durationMs: 0, curve: "linear" },
      { value: 0, durationMs: 4600, curve: "linear" },
    ]);
  });

  it("runs an alternate motion forwards then back in one loop, easing mirrored", () => {
    expect(sealTimeline(motionOf("waiting", "shadow")).steps).toEqual([
      { value: -55, durationMs: 0, curve: "linear" },
      { value: 55, durationMs: 9000, curve: [0.42, 0, 0.58, 1] },
      { value: -55, durationMs: 9000, curve: [0.42, 0, 0.58, 1] },
    ]);
    const skewed: SealMotion = {
      property: "opacity",
      keyframes: [
        { at: 0, value: 0 },
        { at: 1, value: 1 },
      ],
      durationMs: 1000,
      easing: [0.3, 0.7, 0.3, 1],
      direction: "alternate",
    };
    expect(sealTimeline(skewed).steps[2]!.curve).toEqual([0.7, 0, 0.7, 0.3]);
  });

  it("spends each motion's whole duration in one loop", () => {
    for (const registered of Object.values(SEAL_SCENE_PACKS)) {
      for (const phase of SEAL_PHASES) {
        for (const layer of registered.phases[phase].layers) {
          for (const motion of sealMotions(layer)) {
            const total = sealTimeline(motion).steps.reduce(
              (sum, step) => sum + step.durationMs,
              0,
            );
            const loops = motion.direction === "alternate" ? 2 : 1;
            expect(total, `${phase} ${layer.id}`).toBe(motion.durationMs * loops);
          }
        }
      }
    }
  });
});

describe("native seal layers", () => {
  it("gives a layer that moves as a whole its own view and shares a canvas otherwise", () => {
    const groups = sealLayerGroups(sealLayers(pack, "starting", 112));
    expect(
      groups.map((group) =>
        group.kind === "transform"
          ? `view:${group.layer.id}`
          : group.layers.map((layer) => layer.id).join("+"),
      ),
    ).toEqual(["view:sun", "horizon+horizon-line+ring"]);
  });

  it("starts each animated property from the layer's still pose", () => {
    const layers = pack.phases.searching.layers;
    const beam = layers.find((layer) => layer.id === "beam")!;
    expect(sealStillValue(beam, "rotate")).toBe(-40);
    const glow = pack.phases.done.layers.find((layer) => layer.id === "glow")!;
    expect(sealStillValue(glow, "opacity")).toBe(0);
    expect(sealStillValue(glow, "scale")).toBe(1);
    const ring = pack.phases.starting.layers.find((layer) => layer.id === "ring")!;
    expect(sealStillValue(ring, "dashOffset")).toBe(132);
  });

  it("prints paper and ink in both themes and takes attention from the theme", () => {
    expect(sealNativeColors("#2F4A7A", "#B7791F")).toEqual({
      pigment: "#2F4A7A",
      paper: lightTokens.background,
      ink: lightTokens.foreground,
      attention: "#B7791F",
    });
  });
});

describe("native seal labels", () => {
  it("names a busy bot's phase and says nothing for a resting one", () => {
    expect(sealPhaseLabelKey("waiting_input")).toBe("Waiting for you");
    expect(sealPhaseLabelKey("idle")).toBeNull();
    expect(sealPhaseLabelKey(undefined)).toBeNull();
  });

  it("translates every pack's phase labels in both mobile catalogs", () => {
    for (const registered of Object.values(SEAL_SCENE_PACKS)) {
      for (const phase of SEAL_PHASES) {
        const labelKey = registered.phases[phase].labelKey;
        expect(RU_MESSAGES[labelKey], `ru: ${labelKey}`).toBeTruthy();
        expect(ZH_MESSAGES[labelKey], `zh: ${labelKey}`).toBeTruthy();
      }
    }
  });
});
