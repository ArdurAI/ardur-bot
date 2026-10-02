export type ChatMarkdownProps = {
  children: string;
  streaming?: boolean;
  /**
   * Show the blinking cursor. Defaults to `streaming`; callers pass false once the
   * reply's text has stopped growing even though the run (and the streaming layout)
   * is still active.
   */
  cursor?: boolean;
};

/** Whether the blinking cursor shows: it follows the reply's text, defaulting to `streaming`. */
export function showsCursor({
  streaming = false,
  cursor,
}: Pick<ChatMarkdownProps, "streaming" | "cursor">): boolean {
  return cursor ?? streaming;
}

/**
 * Cursor props for the native streaming view. A hidden cursor is drawn transparent, not
 * resized, so it keeps its space and the reply bubble does not shrink when the text pauses
 * for a tool call and grow back when it resumes.
 */
export function nativeCursorProps(
  props: Pick<ChatMarkdownProps, "streaming" | "cursor">,
  color: string,
): { cursorColor: string } {
  return { cursorColor: showsCursor(props) ? color : "transparent" };
}

const protocolPattern = /^([a-z][a-z\d+.-]*):/i;
const safeProtocols = new Set(["http", "https", "mailto", "tel"]);

export function sanitizeMarkdownUrl(url: string, allowRelative = false): string | undefined {
  const value = url.trim();
  const protocol = value.match(protocolPattern)?.[1]?.toLowerCase();

  if (protocol) return safeProtocols.has(protocol) ? value : undefined;
  if (
    allowRelative &&
    (value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("#") ||
      /^[^?#:\\\s]+\.[a-z0-9]+(?:#L[1-9][0-9]*)?$/i.test(value))
  ) {
    return value;
  }
  return undefined;
}

export function closeUnterminatedFence(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of markdown.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match?.[1]) continue;

    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      openFence = { marker, length: match[1].length };
      continue;
    }

    if (
      marker === openFence.marker &&
      match[1].length >= openFence.length &&
      (match[2] ?? "").trim() === ""
    ) {
      openFence = undefined;
    }
  }

  return openFence ? `${markdown}\n${openFence.marker.repeat(openFence.length)}` : markdown;
}
