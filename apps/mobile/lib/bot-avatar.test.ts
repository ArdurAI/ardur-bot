import { resolvePersonaColorDef, shippedBotAvatarShapePath } from "@ardurbot/core";
import { describe, expect, it } from "vitest";
import { mobileBotAvatarPresentation, sealEdgePath } from "./bot-avatar.js";

describe("mobile bot avatar presentation", () => {
  it("keeps the stored shape path instead of dropping it to a color fill", () => {
    const presented = mobileBotAvatarPresentation("#8B5CF6::shape_3");
    expect(presented).toEqual({
      kind: "shape",
      color: "#8B5CF6",
      shapeIndex: 3,
      shapePath: shippedBotAvatarShapePath(3),
      eyeColor: resolvePersonaColorDef("preview", "#8B5CF6").eyeColor,
    });
    expect(presented.kind === "shape" && presented.shapePath).not.toBe(
      shippedBotAvatarShapePath(0),
    );
  });

  it("uses the shared palette eye color for Amber Gold", () => {
    const presented = mobileBotAvatarPresentation("#EAB308::shape_1");
    expect(presented.kind).toBe("shape");
    if (presented.kind !== "shape") return;
    expect(presented.eyeColor).toBe("#F6F3EC");
    expect(presented.eyeColor).toBe(resolvePersonaColorDef("preview", "#EAB308").eyeColor);
  });

  it("still treats hex, data images, and remote URLs as before", () => {
    expect(mobileBotAvatarPresentation("#8B5CF6")).toEqual({ kind: "color", color: "#8B5CF6" });
    expect(mobileBotAvatarPresentation("data:image/png;base64,abc")).toEqual({
      kind: "image",
      imageUrl: "data:image/png;base64,abc",
    });
    expect(mobileBotAvatarPresentation("https://evil.example/track.png")).toEqual({
      kind: "other",
      raw: "https://evil.example/track.png",
    });
  });
});

const STROKE = 2;
const INSET = STROKE / 2;

/** x/y bounds of a path from its on-curve points (elliptical arcs stay inside their endpoint box). */
function pathBounds(path: string): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const seg of path.matchAll(/([MLAZ])([^MLAZ]*)/g)) {
    const cmd = seg[1];
    const coords = seg[2] ?? "";
    const args = coords.split(",").map(Number);
    if (cmd === "A") {
      // rx,ry,rotation,large-arc,sweep,x,y — the endpoint is the last pair.
      xs.push(args[5] ?? 0);
      ys.push(args[6] ?? 0);
    } else if (cmd === "M" || cmd === "L") {
      xs.push(args[0] ?? 0);
      ys.push(args[1] ?? 0);
    }
  }
  if (xs.length === 0 || xs.length !== ys.length) throw new Error(`unparseable path: ${path}`);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe("sealEdgePath", () => {
  const sizes = [20, 24, 28, 36, 40, 54, 64];

  it.each(sizes)("keeps the 2px stroke inside the %ipx viewBox by half the stroke", (s) => {
    const { minX, maxX, minY, maxY } = pathBounds(sealEdgePath(s));
    expect(minX).toBeCloseTo(INSET, 6);
    expect(maxX).toBeCloseTo(s - INSET, 6);
    expect(minY).toBeCloseTo(INSET, 6);
    expect(maxY).toBeCloseTo(s - INSET, 6);
  });

  it("uses a true circle below 28px and the hand-cut edge at 28px and above", () => {
    const circle = sealEdgePath(24);
    expect(circle).toBe(
      [
        `M${INSET + 11},${INSET}`,
        `A11,11,0,0,1,${INSET + 22},${INSET + 11}`,
        `A11,11,0,0,1,${INSET + 11},${INSET + 22}`,
        `A11,11,0,0,1,${INSET},${INSET + 11}`,
        `A11,11,0,0,1,${INSET + 11},${INSET}`,
        "Z",
      ].join(""),
    );
    // Hand-cut edge keeps its distinct corner radii after the inset.
    expect(sealEdgePath(40)).toContain(`A${38 * 0.48},${38 * 0.51},0,0,1,`);
    expect(sealEdgePath(40)).toContain(`A${38 * 0.52},${38 * 0.49},0,0,1,`);
  });
});
