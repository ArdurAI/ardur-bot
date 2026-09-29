import { describe, expect, it } from "vitest";
import type { SealColors, SealLayer, SealScenePack, SealShape } from "./index.js";
import {
  DEFAULT_SEAL_SCENE_PACK,
  isSealTransformMotion,
  SEAL_MOTION_PROPERTIES,
  SEAL_PAINTS,
  SEAL_PHASES,
  SEAL_PICTURE_BANDS,
  SEAL_SCENE_PACKS,
  sealLayers,
  sealMotions,
  sealScenePack,
  sealStillProps,
} from "./index.js";

const packs = Object.values(SEAL_SCENE_PACKS);
/** Token names stand in for colours so signatures compare paint, not theme. */
const TOKEN_COLORS: SealColors = {
  pigment: "pigment",
  paper: "paper",
  ink: "ink",
  attention: "attention",
};

function everyLayer(pack: SealScenePack): SealLayer[] {
  return SEAL_PHASES.flatMap((phase) => pack.phases[phase].layers);
}

function shapeCoordinates(shape: SealShape): number[] {
  switch (shape.kind) {
    case "circle":
      return [shape.cx - shape.r, shape.cx + shape.r, shape.cy - shape.r, shape.cy + shape.r];
    case "rect":
      return [shape.x, shape.y, shape.x + shape.width, shape.y + shape.height];
    case "line":
      return [shape.x1, shape.y1, shape.x2, shape.y2];
    case "path":
      return (shape.d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  }
}

/** True when the still pose paints something: a visible layer with a visible fill or stroke. */
function paintsWhenStill(layer: SealLayer): boolean {
  if (layer.opacity === 0) return false;
  return (
    (layer.fill !== undefined && layer.fill.opacity !== 0) ||
    (layer.stroke !== undefined && layer.stroke.opacity !== 0)
  );
}

describe.each(packs)("the $name pack", (pack) => {
  it("defines every phase, and every phase has a label", () => {
    expect(Object.keys(pack.phases).sort()).toEqual([...SEAL_PHASES].sort());
    for (const phase of SEAL_PHASES) expect(pack.phases[phase].labelKey.trim()).not.toBe("");
  });

  it("paints only with tokens, never a colour value", () => {
    for (const layer of everyLayer(pack)) {
      for (const paint of [layer.fill?.paint, layer.stroke?.paint]) {
        if (paint !== undefined) expect(SEAL_PAINTS).toContain(paint);
      }
    }
    const data = JSON.stringify(pack);
    expect(data).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(data).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/i);
  });

  it("keeps every shape and transform origin inside the 100 × 100 viewBox", () => {
    for (const layer of everyLayer(pack)) {
      for (const value of shapeCoordinates(layer.shape)) {
        expect(value, `${layer.id}`).toBeGreaterThanOrEqual(0);
        expect(value, `${layer.id}`).toBeLessThanOrEqual(100);
      }
      for (const motion of sealMotions(layer)) {
        for (const value of motion.origin ?? []) {
          expect(value, `${layer.id} origin`).toBeGreaterThanOrEqual(0);
          expect(value, `${layer.id} origin`).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("animates only known properties, with keyframes spanning the whole loop", () => {
    for (const layer of everyLayer(pack)) {
      for (const motion of sealMotions(layer)) {
        expect(SEAL_MOTION_PROPERTIES).toContain(motion.property);
        expect(motion.durationMs).toBeGreaterThan(0);
        expect(motion.delayMs ?? 0).toBeGreaterThanOrEqual(0);
        const offsets = motion.keyframes.map((keyframe) => keyframe.at);
        expect(offsets.length, layer.id).toBeGreaterThanOrEqual(2);
        expect(offsets[0], layer.id).toBe(0);
        expect(offsets.at(-1), layer.id).toBe(1);
        expect(offsets, layer.id).toEqual([...offsets].sort((a, b) => a - b));
      }
    }
  });

  it("moves a layer through one transform at most, and a still rotation only by rotating", () => {
    for (const layer of everyLayer(pack)) {
      const transforms = sealMotions(layer).filter(isSealTransformMotion);
      expect(transforms.length, layer.id).toBeLessThanOrEqual(1);
      if (layer.rotate !== undefined) {
        for (const motion of transforms) {
          expect(motion.property, layer.id).toBe("rotate");
          expect(motion.origin ?? [50, 50], layer.id).toEqual([50, 50]);
        }
      }
    }
  });

  it("names each layer once within its phase", () => {
    for (const phase of SEAL_PHASES) {
      const ids = pack.phases[phase].layers.map((layer) => layer.id);
      expect(new Set(ids).size, phase).toBe(ids.length);
    }
  });

  it("gives every phase but idle a layer that shows at small sizes when still", () => {
    for (const phase of SEAL_PHASES) {
      if (phase === "idle") continue;
      expect(sealLayers(pack, phase, 24).some(paintsWhenStill), phase).toBe(true);
    }
  });

  it("never lets two phases look the same at 24 px when still", () => {
    const signature = (phase: (typeof SEAL_PHASES)[number]) =>
      JSON.stringify(
        sealLayers(pack, phase, 24).map((layer) => sealStillProps(layer, 24, TOKEN_COLORS)),
      );
    const byLook = new Map<string, string[]>();
    for (const phase of SEAL_PHASES) {
      const key = signature(phase);
      byLook.set(key, [...(byLook.get(key) ?? []), phase]);
    }
    expect([...byLook.values()].filter((phases) => phases.length > 1)).toEqual([]);
  });
});

describe("seal scene registry", () => {
  it("registers each pack under its own id", () => {
    for (const [id, pack] of Object.entries(SEAL_SCENE_PACKS)) expect(pack.id).toBe(id);
  });

  it("falls back to the default pack for a missing or unknown id", () => {
    const fallback = SEAL_SCENE_PACKS[DEFAULT_SEAL_SCENE_PACK];
    expect(fallback).toBeDefined();
    expect(sealScenePack()).toBe(fallback);
    expect(sealScenePack(null)).toBe(fallback);
    expect(sealScenePack("retired-pack")).toBe(fallback);
    expect(sealScenePack("simple-ring").name).toBe("Simple ring");
  });
});

describe("seal layers at a size", () => {
  const pack = sealScenePack("landscapes-wonders");

  it("hides scene layers below 40 px and small-only layers from 40 px", () => {
    const ids = (size: number) => sealLayers(pack, "waiting", size).map((layer) => layer.id);
    expect(ids(39)).toEqual(["tide", "ring", "dot"]);
    expect(ids(40)).toEqual([
      "tick-1",
      "tick-2",
      "tick-3",
      "tick-4",
      "tick-5",
      "shadow",
      "gnomon",
      "ring",
      "dot",
    ]);
  });

  it("orders layers by band whatever order the pack lists them in", () => {
    const shuffled: SealScenePack = {
      ...pack,
      phases: {
        ...pack.phases,
        waiting: { ...pack.phases.waiting, layers: [...pack.phases.waiting.layers].reverse() },
      },
    };
    const bands = sealLayers(shuffled, "waiting", 24).map((layer) => layer.band);
    expect(bands).toEqual(["scene", "ring", "badge"]);
  });

  it("limits picture avatars to the ring and badge bands", () => {
    const layers = sealLayers(pack, "starting", 112, SEAL_PICTURE_BANDS);
    expect(layers.map((layer) => layer.id)).toEqual(["ring"]);
  });

  it("resolves named stroke widths and still rotation per size", () => {
    const [ring] = sealLayers(pack, "starting", 24);
    expect(sealStillProps(ring!, 24, TOKEN_COLORS)).toMatchObject({
      element: "circle",
      fill: "none",
      stroke: "paper",
      strokeWidth: 7,
      strokeDasharray: "264 264",
      strokeDashoffset: 132,
      transform: "rotate(90 50 50)",
    });
    expect(sealStillProps(ring!, 112, TOKEN_COLORS)).toMatchObject({ strokeWidth: 4 });
  });
});
