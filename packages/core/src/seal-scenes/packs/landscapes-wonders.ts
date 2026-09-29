import type { SealEasing, SealLayer, SealMotion, SealScenePack, SealShape } from "../types.js";

/**
 * Calm landscapes, with wonders for the moments that matter. Transcribed from
 * the approved B34 canvas: geometry from its scenes, timing from its keyframes.
 * Stroke-only layers fade through `opacity`, which looks the same as the
 * canvas's stroke-opacity and stays on the cheaper animation path.
 */

const RING: SealShape = { kind: "circle", cx: 50, cy: 50, r: 42 };
const SUNRISE: SealEasing = [0.3, 0.7, 0.3, 1];
const ECLIPSE: SealEasing = [0.2, 0.7, 0.3, 1];

/** Pigment below the horizon hides the rising and setting sun. */
const HORIZON: readonly SealLayer[] = [
  {
    id: "horizon",
    band: "scene",
    sizes: "large",
    shape: { kind: "path", d: "M12.53 80 L87.47 80 A48 48 0 0 1 12.53 80 Z" },
    fill: { paint: "pigment" },
  },
  {
    id: "horizon-line",
    band: "scene",
    sizes: "large",
    shape: { kind: "line", x1: 18, y1: 80, x2: 82, y2: 80 },
    stroke: { paint: "paper", opacity: 0.55, width: 2.5, linecap: "round" },
  },
];

const AURORA_DRIFT = [
  { at: 0, value: 0 },
  { at: 1, value: -36 },
];

const stepFill = (delayMs: number): SealMotion => ({
  property: "fillOpacity",
  keyframes: [
    { at: 0, value: 0.04 },
    { at: 0.18, value: 0.26 },
    { at: 0.82, value: 0.26 },
    { at: 1, value: 0.04 },
  ],
  durationMs: 4800,
  easing: "ease-in-out",
  delayMs,
});

const segmentFill = (delayMs: number): SealMotion => ({
  property: "opacity",
  keyframes: [
    { at: 0, value: 0.25 },
    { at: 0.15, value: 0.95 },
    { at: 0.8, value: 0.95 },
    { at: 1, value: 0.25 },
  ],
  durationMs: 4800,
  easing: "ease-in-out",
  delayMs,
});

const tick = (id: string, x1: number, y1: number, x2: number, y2: number): SealLayer => ({
  id,
  band: "scene",
  sizes: "large",
  shape: { kind: "line", x1, y1, x2, y2 },
  stroke: { paint: "paper", opacity: 0.55, width: 2, linecap: "round" },
});

const RING_SETTLE: SealMotion = {
  property: "opacity",
  keyframes: [
    { at: 0, value: 1 },
    { at: 0.6, value: 0.55 },
    { at: 1, value: 0.55 },
  ],
  durationMs: 4000,
  easing: "ease-out",
};

export const landscapesWonders: SealScenePack = {
  id: "landscapes-wonders",
  name: "Landscapes and wonders",
  phases: {
    idle: { labelKey: "Idle", layers: [] },

    // Sunrise: the sun climbs out of the horizon while the ring draws itself.
    starting: {
      labelKey: "Starting",
      layers: [
        {
          id: "sun",
          band: "scene",
          sizes: "large",
          shape: { kind: "circle", cx: 50, cy: 80, r: 8 },
          fill: { paint: "paper", opacity: 0.7 },
          motion: {
            property: "translateY",
            keyframes: [
              { at: 0, value: 10 },
              { at: 0.45, value: -9 },
              { at: 1, value: -9 },
            ],
            durationMs: 3600,
            easing: SUNRISE,
          },
        },
        ...HORIZON,
        {
          id: "ring",
          band: "ring",
          sizes: "all",
          shape: RING,
          stroke: {
            paint: "paper",
            opacity: 0.9,
            width: "ring",
            linecap: "round",
            dasharray: [264, 264],
            dashoffset: 132,
          },
          rotate: 90,
          motion: {
            property: "dashOffset",
            keyframes: [
              { at: 0, value: 264 },
              { at: 0.45, value: 0 },
              { at: 1, value: 0 },
            ],
            durationMs: 3600,
            easing: SUNRISE,
          },
        },
      ],
    },

    // Aurora: three dashed bands drift above the initial; the ring breathes.
    thinking: {
      labelKey: "Thinking",
      layers: [
        {
          id: "aurora-1",
          band: "scene",
          sizes: "large",
          shape: { kind: "path", d: "M26 22 Q38 14 50 22 T74 22" },
          stroke: {
            paint: "paper",
            opacity: 0.55,
            width: 3.5,
            linecap: "round",
            dasharray: [10, 8],
          },
          motion: {
            property: "dashOffset",
            keyframes: AURORA_DRIFT,
            durationMs: 3200,
            easing: "linear",
          },
        },
        {
          id: "aurora-2",
          band: "scene",
          sizes: "large",
          shape: { kind: "path", d: "M20 30 Q35 22 50 30 T80 30" },
          stroke: { paint: "paper", opacity: 0.38, width: 3, linecap: "round", dasharray: [10, 8] },
          motion: {
            property: "dashOffset",
            keyframes: AURORA_DRIFT,
            durationMs: 4600,
            easing: "linear",
            direction: "reverse",
          },
        },
        {
          id: "aurora-3",
          band: "scene",
          sizes: "large",
          shape: { kind: "path", d: "M17 38 Q33 31 50 38 T83 38" },
          stroke: {
            paint: "paper",
            opacity: 0.24,
            width: 2.5,
            linecap: "round",
            dasharray: [10, 8],
          },
          motion: {
            property: "dashOffset",
            keyframes: AURORA_DRIFT,
            durationMs: 6000,
            easing: "linear",
          },
        },
        {
          id: "ring",
          band: "ring",
          sizes: "all",
          shape: RING,
          stroke: { paint: "paper", width: "ring" },
          opacity: 0.65,
          motion: {
            property: "opacity",
            keyframes: [
              { at: 0, value: 0.35 },
              { at: 0.5, value: 0.95 },
              { at: 1, value: 0.35 },
            ],
            durationMs: 3200,
            easing: "ease-in-out",
          },
        },
      ],
    },

    // Lighthouse: a beam sweeps round a lamp; a bright arc tracks it on the ring.
    searching: {
      labelKey: "Searching",
      layers: [
        {
          id: "beam",
          band: "scene",
          sizes: "large",
          shape: { kind: "path", d: "M50 50 L87.59 36.32 A40 40 0 0 1 87.59 63.68 Z" },
          fill: { paint: "paper", opacity: 0.28 },
          rotate: -40,
          motion: {
            property: "rotate",
            keyframes: [
              { at: 0, value: -40 },
              { at: 1, value: 320 },
            ],
            durationMs: 2800,
            easing: "linear",
          },
        },
        {
          id: "lamp",
          band: "scene",
          sizes: "large",
          shape: { kind: "circle", cx: 50, cy: 50, r: 3.5 },
          fill: { paint: "paper", opacity: 0.9 },
        },
        {
          id: "ring",
          band: "ring",
          sizes: "all",
          shape: RING,
          stroke: { paint: "paper", opacity: 0.22, width: "ring" },
        },
        {
          id: "beam-ring",
          band: "ring",
          sizes: "all",
          shape: RING,
          stroke: {
            paint: "paper",
            opacity: 0.95,
            width: "ring",
            linecap: "round",
            dasharray: [30, 234],
          },
          rotate: -60,
          motion: {
            property: "rotate",
            keyframes: [
              { at: 0, value: -60 },
              { at: 1, value: 300 },
            ],
            durationMs: 2800,
            easing: "linear",
          },
        },
      ],
    },

    // Stepped pyramid: its tiers fill in turn while ring segments light one by one.
    steps: {
      labelKey: "Working through steps",
      layers: [
        {
          id: "step-1",
          band: "scene",
          sizes: "large",
          shape: { kind: "rect", x: 24, y: 24, width: 52, height: 52, rx: 3 },
          fill: { paint: "ink", opacity: 0.24 },
          stroke: { paint: "paper", opacity: 0.55, width: 1.5 },
          motion: stepFill(0),
        },
        {
          id: "step-2",
          band: "scene",
          sizes: "large",
          shape: { kind: "rect", x: 32, y: 32, width: 36, height: 36, rx: 2.5 },
          fill: { paint: "ink", opacity: 0.24 },
          stroke: { paint: "paper", opacity: 0.55, width: 1.5 },
          motion: stepFill(800),
        },
        {
          id: "step-3",
          band: "scene",
          sizes: "large",
          shape: { kind: "rect", x: 40, y: 40, width: 20, height: 20, rx: 2 },
          fill: { paint: "ink", opacity: 0.04 },
          stroke: { paint: "paper", opacity: 0.55, width: 1.5 },
          motion: stepFill(1600),
        },
        {
          id: "segment-1",
          band: "ring",
          sizes: "all",
          shape: { kind: "path", d: "M53.66 8.16 A42 42 0 0 1 91.84 46.34" },
          stroke: { paint: "paper", width: "ring", linecap: "butt" },
          opacity: 0.95,
          motion: segmentFill(0),
        },
        {
          id: "segment-2",
          band: "ring",
          sizes: "all",
          shape: { kind: "path", d: "M91.84 53.66 A42 42 0 0 1 53.66 91.84" },
          stroke: { paint: "paper", width: "ring", linecap: "butt" },
          opacity: 0.95,
          motion: segmentFill(900),
        },
        {
          id: "segment-3",
          band: "ring",
          sizes: "all",
          shape: { kind: "path", d: "M46.34 91.84 A42 42 0 0 1 8.16 53.66" },
          stroke: { paint: "paper", width: "ring", linecap: "butt" },
          opacity: 0.25,
          motion: segmentFill(1800),
        },
        {
          id: "segment-4",
          band: "ring",
          sizes: "all",
          shape: { kind: "path", d: "M8.16 46.34 A42 42 0 0 1 46.34 8.16" },
          stroke: { paint: "paper", width: "ring", linecap: "butt" },
          opacity: 0.25,
          motion: segmentFill(2700),
        },
      ],
    },

    // Sundial: the shadow swings over the hour ticks; a tide rises when small.
    waiting: {
      labelKey: "Waiting for you",
      layers: [
        tick("tick-1", 21.42, 33.5, 17.09, 31),
        tick("tick-2", 33.5, 21.42, 31, 17.09),
        tick("tick-3", 50, 17, 50, 12),
        tick("tick-4", 66.5, 21.42, 69, 17.09),
        tick("tick-5", 78.58, 33.5, 82.91, 31),
        {
          id: "shadow",
          band: "scene",
          sizes: "large",
          shape: { kind: "line", x1: 50, y1: 50, x2: 50, y2: 21 },
          stroke: { paint: "ink", opacity: 0.5, width: 3.5, linecap: "round" },
          rotate: -25,
          motion: {
            property: "rotate",
            keyframes: [
              { at: 0, value: -55 },
              { at: 1, value: 55 },
            ],
            durationMs: 9000,
            easing: "ease-in-out",
            direction: "alternate",
          },
        },
        {
          id: "gnomon",
          band: "scene",
          sizes: "large",
          shape: { kind: "circle", cx: 50, cy: 50, r: 3.5 },
          fill: { paint: "paper", opacity: 0.85 },
        },
        {
          id: "tide",
          band: "scene",
          sizes: "small",
          shape: { kind: "path", d: "M8.43 74 L91.57 74 A48 48 0 0 1 8.43 74 Z" },
          fill: { paint: "paper", opacity: 0.42 },
          motion: {
            property: "translateY",
            keyframes: [
              { at: 0, value: 0 },
              { at: 0.5, value: -4 },
              { at: 1, value: 0 },
            ],
            durationMs: 7000,
            easing: "ease-in-out",
          },
        },
        {
          id: "ring",
          band: "ring",
          sizes: "all",
          shape: RING,
          stroke: { paint: "paper", opacity: 0.3, width: "ring" },
        },
        {
          id: "dot",
          band: "badge",
          sizes: "all",
          shape: { kind: "circle", cx: 85, cy: 15, r: 11 },
          fill: { paint: "attention" },
          stroke: { paint: "ink", width: 3 },
          motion: {
            property: "opacity",
            keyframes: [
              { at: 0, value: 1 },
              { at: 0.5, value: 0.6 },
              { at: 1, value: 1 },
            ],
            durationMs: 2400,
            easing: "ease-in-out",
          },
        },
      ],
    },

    // Not on the canvas: a waiting takeover keeps today's dashed edge.
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

    // The sunrise settles: the sun sinks to rest with a fading glow.
    done: {
      labelKey: "Done",
      layers: [
        {
          id: "glow",
          band: "scene",
          sizes: "large",
          shape: { kind: "circle", cx: 50, cy: 71, r: 14 },
          stroke: { paint: "paper", opacity: 0.6, width: 2 },
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
                { at: 0.5, value: 1.5 },
                { at: 1, value: 1.5 },
              ],
              durationMs: 4000,
              easing: "ease-out",
              origin: [50, 71],
            },
          ],
        },
        {
          id: "sun",
          band: "scene",
          sizes: "large",
          shape: { kind: "circle", cx: 50, cy: 71, r: 8 },
          fill: { paint: "paper", opacity: 0.75 },
          motion: {
            property: "translateY",
            keyframes: [
              { at: 0, value: -6 },
              { at: 0.35, value: 0 },
              { at: 1, value: 0 },
            ],
            durationMs: 4000,
            easing: "ease-out",
          },
        },
        ...HORIZON,
        {
          id: "ring",
          band: "ring",
          sizes: "large",
          shape: RING,
          stroke: { paint: "paper", opacity: 0.7, width: "ring" },
          motion: RING_SETTLE,
        },
        {
          id: "ring-small",
          band: "ring",
          sizes: "small",
          shape: RING,
          stroke: { paint: "paper", opacity: 0.3, width: "ring" },
          motion: RING_SETTLE,
        },
        {
          id: "sun-small",
          band: "ring",
          sizes: "small",
          shape: { kind: "circle", cx: 50, cy: 86, r: 9 },
          fill: { paint: "paper", opacity: 0.9 },
        },
      ],
    },

    // Eclipse: the moon slides over the sun as a dark bite closes on the ring.
    error: {
      labelKey: "Something went wrong",
      layers: [
        {
          id: "sun",
          band: "scene",
          sizes: "large",
          shape: { kind: "circle", cx: 50, cy: 24, r: 11 },
          fill: { paint: "paper", opacity: 0.8 },
        },
        {
          id: "moon",
          band: "scene",
          sizes: "large",
          shape: { kind: "circle", cx: 51, cy: 24, r: 10 },
          fill: { paint: "ink", opacity: 0.92 },
          motion: {
            property: "translateX",
            keyframes: [
              { at: 0, value: 20 },
              { at: 0.45, value: 0 },
              { at: 1, value: 0 },
            ],
            durationMs: 4200,
            easing: ECLIPSE,
          },
        },
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
          motion: {
            property: "rotate",
            keyframes: [
              { at: 0, value: -150 },
              { at: 0.45, value: -110 },
              { at: 1, value: -110 },
            ],
            durationMs: 4200,
            easing: ECLIPSE,
          },
        },
      ],
    },
  },
};
