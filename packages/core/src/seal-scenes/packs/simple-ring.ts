import type { SealLayer, SealMotion, SealScenePack, SealShape } from "../types.js";

/**
 * The plain running ring the seal used before scenes: a paper arc that turns
 * once every 1.6 s. Each phase changes only the arc's dashes or adds a badge,
 * so every phase still reads apart when small and still.
 */

const RING: SealShape = { kind: "circle", cx: 50, cy: 50, r: 42 };

const SPIN: SealMotion = {
  property: "rotate",
  keyframes: [
    { at: 0, value: -60 },
    { at: 1, value: 300 },
  ],
  durationMs: 1600,
  easing: "linear",
};

/** A turning arc; the dashes add up to the ring's circumference. */
const arc = (dasharray: readonly number[], linecap: "round" | "butt" = "round"): SealLayer => ({
  id: "arc",
  band: "ring",
  sizes: "all",
  shape: RING,
  stroke: { paint: "paper", opacity: 0.9, width: "ring", linecap, dasharray },
  rotate: -60,
  motion: SPIN,
});

export const simpleRing: SealScenePack = {
  id: "simple-ring",
  name: "Simple ring",
  phases: {
    idle: { labelKey: "Idle", layers: [] },
    starting: { labelKey: "Starting", layers: [arc([66, 198])] },
    // Today's running ring: three quarters of the circle.
    thinking: { labelKey: "Thinking", layers: [arc([198, 66])] },
    searching: { labelKey: "Searching", layers: [arc([99, 33])] },
    steps: { labelKey: "Working through steps", layers: [arc([58, 8], "butt")] },
    waiting: {
      labelKey: "Waiting for you",
      layers: [
        {
          id: "dot",
          band: "badge",
          sizes: "all",
          shape: { kind: "circle", cx: 85, cy: 15, r: 11 },
          fill: { paint: "attention" },
          stroke: { paint: "ink", width: 3 },
        },
      ],
    },
    paused: {
      labelKey: "Paused",
      layers: [
        {
          id: "edge",
          band: "ring",
          sizes: "all",
          shape: { kind: "circle", cx: 50, cy: 50, r: 46 },
          stroke: { paint: "paper", opacity: 0.9, width: "ring", dasharray: [8, 6] },
        },
      ],
    },
    done: {
      labelKey: "Done",
      layers: [
        {
          id: "ring",
          band: "ring",
          sizes: "all",
          shape: RING,
          stroke: { paint: "paper", opacity: 0.7, width: "ring" },
          motion: {
            property: "opacity",
            keyframes: [
              { at: 0, value: 1 },
              { at: 0.6, value: 0.55 },
              { at: 1, value: 0.55 },
            ],
            durationMs: 4000,
            easing: "ease-out",
          },
        },
      ],
    },
    error: {
      labelKey: "Something went wrong",
      layers: [
        {
          id: "ring",
          band: "ring",
          sizes: "all",
          shape: RING,
          stroke: { paint: "paper", opacity: 0.3, width: "thin" },
        },
        {
          id: "bite",
          band: "ring",
          sizes: "all",
          shape: RING,
          stroke: {
            paint: "ink",
            opacity: 0.85,
            width: "ring",
            linecap: "round",
            dasharray: [44, 220],
          },
          rotate: -110,
        },
      ],
    },
  },
};
