import type { SealScene, SealScenePack } from "@ardurbot/core";
import { SEAL_PHASES, SEAL_SCENE_PACKS, sealMotions } from "@ardurbot/core";
import { describe, expect, it } from "vitest";
import { sealMotionClass, sealSceneCss } from "./seal-scene-css.js";

const rest: SealScene = { labelKey: "Idle", layers: [] };
const pack: SealScenePack = {
  id: "fixture",
  name: "Fixture",
  phases: {
    idle: rest,
    starting: rest,
    searching: rest,
    steps: rest,
    waiting: rest,
    paused: rest,
    done: rest,
    error: rest,
    thinking: {
      labelKey: "Thinking",
      layers: [
        {
          id: "glow",
          band: "scene",
          sizes: "all",
          shape: { kind: "circle", cx: 50, cy: 71, r: 14 },
          stroke: { paint: "paper", width: 2 },
          opacity: 0,
          motion: [
            {
              property: "opacity",
              keyframes: [
                { at: 0, value: 0.8 },
                { at: 0.5, value: 0 },
                { at: 1, value: 0 },
              ],
              durationMs: 4000,
              easing: "ease-out",
            },
            {
              property: "scale",
              keyframes: [
                { at: 0, value: 1 },
                { at: 1, value: 1.5 },
              ],
              durationMs: 4000,
              easing: [0.2, 0.7, 0.3, 1],
              delayMs: 900,
              direction: "alternate",
              origin: [50, 71],
            },
          ],
        },
        {
          id: "track",
          band: "ring",
          sizes: "all",
          shape: { kind: "circle", cx: 50, cy: 50, r: 42 },
          stroke: { paint: "paper", width: "ring" },
        },
      ],
    },
  },
};

describe("seal scene CSS", () => {
  const css = sealSceneCss(pack);

  it("compiles one keyframes block per motion and one rule per moving layer", () => {
    expect(css).toContain(
      "@keyframes ardurbot-seal-fixture-thinking-glow-0 { 0% { opacity: 0.8 } 50% { opacity: 0 } 100% { opacity: 0 } }",
    );
    expect(css).toContain(
      "@keyframes ardurbot-seal-fixture-thinking-glow-1 { 0% { transform: scale(1) } 100% { transform: scale(1.5) } }",
    );
    expect(css.match(/@keyframes /g)).toHaveLength(2);
    expect(css).not.toContain("thinking-track");
    expect(css).toContain(
      ':root:not([data-motion="reduced"]) .ardurbot-seal-fixture-thinking-glow { ' +
        "animation-name: ardurbot-seal-fixture-thinking-glow-0, ardurbot-seal-fixture-thinking-glow-1; " +
        "animation-duration: 4000ms, 4000ms; " +
        "animation-timing-function: ease-out, cubic-bezier(0.2, 0.7, 0.3, 1); " +
        "animation-delay: 0ms, 900ms; " +
        "animation-direction: normal, alternate; " +
        "animation-iteration-count: infinite; animation-fill-mode: both; " +
        "transform-box: view-box; transform-origin: 50px 71px }",
    );
  });

  it("plays only when the reader allows motion, and leaves pausing to the page", () => {
    expect(css.startsWith("@media (prefers-reduced-motion: no-preference) {")).toBe(true);
    expect(css).not.toContain("animation-play-state");
    expect(css).not.toContain("animation:");
  });

  it("gives every moving layer of every registered pack its rule", () => {
    for (const registered of Object.values(SEAL_SCENE_PACKS)) {
      const compiled = sealSceneCss(registered);
      for (const phase of SEAL_PHASES) {
        for (const layer of registered.phases[phase].layers) {
          const className = sealMotionClass(registered.id, phase, layer.id);
          expect(compiled.includes(`.${className} {`), className).toBe(
            sealMotions(layer).length > 0,
          );
        }
      }
    }
  });
});
