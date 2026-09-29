import type { SealColors, SealLayer, SealPhase, SealScenePack } from "@ardurbot/core";
import { sealMotions, sealScenePack, sealStillProps } from "@ardurbot/core";
import { sealPaints } from "@ardurbot/ui-tokens";
import type { ReactNode } from "react";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useInsertionEffect,
  useSyncExternalStore,
} from "react";
import { sealMotionClass, sealSceneCss } from "./seal-scene-css.js";

const SealScenePackContext = createContext<SealScenePack>(sealScenePack());

/** Chooses the seal scene pack by id; unknown ids use the default pack. */
export function SealScenePackProvider({
  value,
  children,
}: {
  value?: string | null;
  children: ReactNode;
}) {
  return <SealScenePackContext value={sealScenePack(value)}>{children}</SealScenePackContext>;
}

export function useSealScenePack(): SealScenePack {
  return useContext(SealScenePackContext);
}

/** Paint for a seal on the web. The attention dot follows the theme's warning colour. */
export function sealWebColors(pigment: string): SealColors {
  return { pigment, paper: sealPaints.paper, ink: sealPaints.ink, attention: "var(--warning)" };
}

const injectedPacks = new Set<string>();

/** Adds a pack's compiled motions to the document once. */
function injectSealSceneCss(pack: SealScenePack) {
  if (injectedPacks.has(pack.id) || typeof document === "undefined") return;
  injectedPacks.add(pack.id);
  const style = document.createElement("style");
  style.dataset.ardurbotSealScenes = pack.id;
  style.textContent = sealSceneCss(pack);
  document.head.append(style);
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const reducedMotionListeners = new Set<() => void>();
let stopWatchingMotion: (() => void) | undefined;

function reducedMotionSnapshot(): boolean {
  return (
    (typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches) ||
    document.documentElement.dataset.motion === "reduced"
  );
}

function subscribeToReducedMotion(listener: () => void): () => void {
  reducedMotionListeners.add(listener);
  if (!stopWatchingMotion) {
    const notify = () => {
      for (const current of reducedMotionListeners) current();
    };
    const media =
      typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
    media?.addEventListener("change", notify);
    // The account's Reduce motion setting lands on <html data-motion>.
    const preference = new MutationObserver(notify);
    preference.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
    stopWatchingMotion = () => {
      media?.removeEventListener("change", notify);
      preference.disconnect();
    };
  }
  return () => {
    reducedMotionListeners.delete(listener);
    if (reducedMotionListeners.size === 0) {
      stopWatchingMotion?.();
      stopWatchingMotion = undefined;
    }
  };
}

/** True when the OS or the account's motion setting asks for reduced motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => false);
}

let offscreenObserver: IntersectionObserver | undefined;

/** A ref that pauses a moving seal's animations while it is scrolled out of view. */
export function usePauseOffscreen(
  moving: boolean,
): (element: Element | null) => (() => void) | undefined {
  return useCallback(
    (element: Element | null) => {
      if (!moving || !element || typeof IntersectionObserver === "undefined") return;
      offscreenObserver ??= new IntersectionObserver((entries) => {
        for (const entry of entries) {
          entry.target.toggleAttribute("data-offscreen", !entry.isIntersecting);
        }
      });
      const observer = offscreenObserver;
      observer.observe(element);
      return () => {
        observer.unobserve(element);
        element.removeAttribute("data-offscreen");
      };
    },
    [moving],
  );
}

/**
 * One SVG of pack layers over a seal. `inset` lines the viewBox up with the
 * seal's outer edge when the host has a border.
 */
export function SealLayers({
  pack,
  phase,
  layers,
  size,
  colors,
  moving,
  inset = 0,
}: {
  pack: SealScenePack;
  phase: SealPhase;
  layers: readonly SealLayer[];
  size: number;
  colors: SealColors;
  moving: boolean;
  inset?: number;
}) {
  useInsertionEffect(() => {
    if (moving) injectSealSceneCss(pack);
  }, [moving, pack]);
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      className="pointer-events-none absolute overflow-visible"
      style={{ top: -inset, left: -inset, width: size, height: size }}
    >
      {layers.map((layer) => {
        const { element, ...props } = sealStillProps(layer, size, colors);
        const className =
          moving && sealMotions(layer).length > 0
            ? sealMotionClass(pack.id, phase, layer.id)
            : undefined;
        return createElement(element, { key: layer.id, className, ...props });
      })}
    </svg>
  );
}
