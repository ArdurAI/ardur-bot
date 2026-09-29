import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sealLayers, sealScenePack, sealStillProps } from "@ardurbot/core";
import { describe, expect, it } from "vitest";
import { sealNativeColors } from "./seal-scene";

const source = readFileSync(
  fileURLToPath(new URL("../components/bot-avatar.tsx", import.meta.url)),
  "utf8",
);
const layersSource = readFileSync(
  fileURLToPath(new URL("../components/seal-layers.tsx", import.meta.url)),
  "utf8",
);

describe("mobile bot avatar", () => {
  it("never leaves a seal layer's fill to react-native-svg, which defaults it to black", () => {
    // Every layer is drawn from the shared still pose, which always sets fill.
    expect(layersSource).toContain("sealStillProps(layer, size, colors)");
    const colors = sealNativeColors("#2F4A7A", "#B7791F");
    for (const layer of sealLayers(sealScenePack(), "thinking", 24)) {
      expect(sealStillProps(layer, 24, colors).fill).toBe("none");
    }
  });

  it("keeps the seal letter hidden from assistive tech", () => {
    // The bot name sits next to the avatar; the decorative initial must not be
    // read out on its own.
    const letter = source.match(/<Text[\s\S]*?\{initial\}/);
    expect(letter).not.toBeNull();
    expect(letter![0]).toContain("accessible={false}");
  });

  it("takes the initial from the first grapheme, not the first code unit", () => {
    expect(source).toContain("avatarInitial");
  });

  it("runs seal motions through Reanimated and holds the still pose under reduced motion", () => {
    expect(source).toContain("moving={!reducedMotion}");
    expect(layersSource).toContain("withRepeat(withSequence(");
    expect(layersSource).toMatch(/moving && painted\.length > 0/);
  });
});
