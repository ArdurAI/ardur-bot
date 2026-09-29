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
