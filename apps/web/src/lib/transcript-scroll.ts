import { useLayoutEffect } from "react";

export function transcriptIsNearEnd(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

export function transcriptCanSnapAfterFrame(
  element: Pick<HTMLElement, "scrollTop"> | null,
  queuedElement: Pick<HTMLElement, "scrollTop">,
  queuedScrollTop: number,
): boolean {
  return element === queuedElement && queuedElement.scrollTop === queuedScrollTop;
}

export function transcriptMovedDown(previousScrollTop: number | null, scrollTop: number): boolean {
  return previousScrollTop !== null && scrollTop >= previousScrollTop;
}

/**
 * Follow-to-end yields while a quote selection is open: snapping would drag
 * the selected text (and the floating Quote action) away from the reader.
 */
export function transcriptSnapFollows(following: boolean, quoteSelectionOpen: boolean): boolean {
  return following && !quoteSelectionOpen;
}

/**
 * Follow-to-end while the reader is at the latest message, except while a
 * quote selection is open. `quoteOpen` is a dependency so closing the quote
 * snaps again even when the messages have not changed.
 */
export function useTranscriptFollowSnap({
  messages,
  running,
  quoteOpen,
  following,
  snapToEnd,
}: {
  messages: unknown;
  running: boolean;
  quoteOpen: boolean;
  following: { readonly current: boolean };
  snapToEnd: () => void;
}): void {
  useLayoutEffect(() => {
    if (transcriptSnapFollows(following.current, quoteOpen)) snapToEnd();
  }, [messages, running, quoteOpen, following, snapToEnd]);
}
