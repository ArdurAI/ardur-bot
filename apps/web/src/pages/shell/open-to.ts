import { useSyncExternalStore } from "react";

export type OpenTo = "dashboard" | "bots";
const KEY = "ardurbot:open-to";
const CHANGE = "ardurbot:open-to-changed";
let fallback: OpenTo | undefined;
export function readOpenTo(): OpenTo {
  if (fallback) return fallback;
  try {
    return window.localStorage.getItem(KEY) === "bots" ? "bots" : "dashboard";
  } catch {
    return "dashboard";
  }
}
export function writeOpenTo(value: OpenTo) {
  try {
    window.localStorage.setItem(KEY, value);
    fallback = undefined;
  } catch {
    fallback = value;
  }
  window.dispatchEvent(new Event(CHANGE));
}
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(CHANGE, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE, listener);
  };
}
export function useOpenTo() {
  return useSyncExternalStore(subscribe, readOpenTo, () => "dashboard" as const);
}
