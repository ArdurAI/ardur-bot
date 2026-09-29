import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** True when this history entry asked the bots list to focus its search box. */
export function sidebarSearchFocusRequested(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { focusSidebarSearch?: unknown }).focusSidebarSearch === true
  );
}

/**
 * The Board and the bots list are different pages, so a flag on the Board's shell
 * is gone after the route change. The history entry carries the request instead.
 * A dashboard that is about to leave does not expand its own hidden list.
 */
export function botsSidebarCollapsedForPage(
  stored: boolean,
  searchRequested: boolean,
  dashboard: boolean,
): boolean {
  return searchRequested && !dashboard ? false : stored;
}

/**
 * Focuses the bots-list search. From the Board (or any dashboard shell that unmounts
 * on the way to `/app/bots`) the request travels in the history state, because the
 * next page is a new shell. On the bots page it opens the list, then focuses.
 */
export function useSidebarSearchFocus(input: {
  dashboard: boolean;
  hidden: boolean;
  ready: boolean;
  reveal: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const pending = useRef(false);
  const [pulse, setPulse] = useState(0);
  const revealRef = useRef(input.reveal);
  revealRef.current = input.reveal;
  const inputRef = useRef(input.inputRef);
  inputRef.current = input.inputRef;

  const request = useCallback(() => {
    if (input.dashboard) {
      navigate("/app/bots", { state: { focusSidebarSearch: true } });
      return;
    }
    revealRef.current();
    pending.current = true;
    setPulse((value) => value + 1);
  }, [input.dashboard, navigate]);

  useEffect(() => {
    if (!input.ready || input.dashboard || !sidebarSearchFocusRequested(location.state)) return;
    if (pending.current) return;
    revealRef.current();
    pending.current = true;
    setPulse((value) => value + 1);
  }, [input.ready, input.dashboard, location.state]);

  useEffect(() => {
    if (!input.ready || !pending.current || input.dashboard) return;
    if (input.hidden) return;
    pending.current = false;
    inputRef.current.current?.focus();
    if (!sidebarSearchFocusRequested(location.state)) return;
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [
    pulse,
    input.ready,
    input.dashboard,
    input.hidden,
    location.pathname,
    location.search,
    location.hash,
    location.state,
    navigate,
  ]);

  return request;
}
