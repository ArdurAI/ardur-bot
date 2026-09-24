import { useContext, useEffect, useLayoutEffect } from "react";
import { UNSAFE_NavigationContext } from "react-router-dom";
import { desktopBridge } from "../../lib/desktop";
import { setPopstateGuard } from "../../lib/navigation-guard";

export function useUnsavedChanges(dirty: boolean, label: string) {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  useLayoutEffect(() => {
    if (!dirty) return;
    const { push, replace } = navigator;
    let current = { state: window.history.state, url: window.location.href };
    let restoring = false;
    const remember = () => {
      current = { state: window.history.state, url: window.location.href };
    };
    // Link and useNavigate consult this same object, including callers outside the IDE.
    const guardedPush: typeof push = (...args) => {
      if (restoring || !window.confirm(label)) return;
      push(...args);
      remember();
    };
    const guardedReplace: typeof replace = (...args) => {
      if (restoring || !window.confirm(label)) return;
      replace(...args);
      remember();
    };
    navigator.push = guardedPush;
    navigator.replace = guardedReplace;
    const pop = (event: PopStateEvent) => {
      const previousIndex: unknown = current.state?.idx;
      const nextIndex: unknown = window.history.state?.idx;
      if (!restoring && window.confirm(label)) {
        remember();
        return;
      }
      // The startup dispatcher runs before BrowserRouter: the dirty editor stays mounted.
      event.stopImmediatePropagation();
      if (restoring && previousIndex === nextIndex) {
        restoring = false;
        return;
      }
      if (
        typeof previousIndex === "number" &&
        typeof nextIndex === "number" &&
        previousIndex !== nextIndex
      ) {
        restoring = true;
        window.history.go(previousIndex - nextIndex);
      } else {
        // An entry made outside the router has no index; preserve the buffer and URL.
        window.history.replaceState(current.state, "", current.url);
        restoring = false;
      }
    };
    const stop = setPopstateGuard(pop);
    return () => {
      if (navigator.push === guardedPush) navigator.push = push;
      if (navigator.replace === guardedReplace) navigator.replace = replace;
      stop();
    };
  }, [dirty, label, navigator]);
  useEffect(() => {
    void desktopBridge()
      ?.window.setUnsavedChanges?.(dirty)
      .catch(() => {});
    return () => {
      void desktopBridge()
        ?.window.setUnsavedChanges?.(false)
        .catch(() => {});
    };
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = label;
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, label]);
}
