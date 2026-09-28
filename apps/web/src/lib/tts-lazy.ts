import type { Speaker } from "./tts";

let speakerPromise: Promise<Speaker> | null = null;
let loaded: Speaker | null = null;
const readyListeners = new Set<(speaker: Speaker) => void>();

/**
 * Loads the voice playback module on first use so it stays out of startup.
 * Repeat calls share one load; a failed load is retried on the next call.
 */
export function loadSpeaker(): Promise<Speaker> {
  speakerPromise ??= import("./tts").then(
    (module) => {
      loaded = module.speaker;
      for (const listener of readyListeners) listener(loaded);
      return loaded;
    },
    (error: unknown) => {
      speakerPromise = null;
      throw error;
    },
  );
  return speakerPromise;
}

/**
 * Runs an action once the speaker module is ready. A failed load is swallowed:
 * every action here is best-effort playback control, and the tts module reports
 * its own failures through the speaker state it publishes.
 */
export function withSpeaker(action: (speaker: Speaker) => void): void {
  void loadSpeaker().then(action, () => undefined);
}

/**
 * Subscribes for the moment the speaker module is loaded, then keeps the
 * returned teardown alive. Never starts the load itself, so surfaces that only
 * mirror playback state keep the module out of startup.
 */
export function whenSpeakerReady(subscribe: (speaker: Speaker) => () => void): () => void {
  let teardown: (() => void) | null = null;
  const listener = (speaker: Speaker) => {
    teardown = subscribe(speaker);
  };
  if (loaded) {
    listener(loaded);
    return () => teardown?.();
  }
  readyListeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    readyListeners.delete(listener);
    teardown?.();
  };
}
