type PopstateGuard = (event: PopStateEvent) => void;
let guard: PopstateGuard | undefined;

/** Register before BrowserRouter: window popstate listeners run in registration order. */
export function installNavigationGuard() {
  const listener = (event: PopStateEvent) => guard?.(event);
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

export function setPopstateGuard(next: PopstateGuard) {
  guard = next;
  return () => {
    if (guard === next) guard = undefined;
  };
}
