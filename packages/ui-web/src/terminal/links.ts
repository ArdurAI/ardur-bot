import { terminalWebLink } from "@ardurbot/core";
import type { IBuffer, ILink, ILinkProvider } from "@xterm/xterm";

/** Resolve logical lines, including wide cells and wraps, without a terminal-driven opener. */
export function terminalLinkProvider(
  buffer: () => IBuffer,
  activate: ILink["activate"],
  hover: NonNullable<ILink["hover"]>,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const active = buffer();
      let first = y - 1,
        last = y - 1;
      while (active.getLine(first)?.isWrapped && first > 0 && y - first <= 16) first--;
      if (active.getLine(first)?.isWrapped) {
        callback(undefined);
        return;
      }
      while (active.getLine(last + 1)?.isWrapped && last - first < 16) last++;
      if (active.getLine(last + 1)?.isWrapped) {
        callback(undefined);
        return;
      }
      let text = "";
      const cells: { start: { x: number; y: number }; end: { x: number; y: number } }[] = [];
      for (let row = first; row <= last; row++) {
        const line = active.getLine(row);
        if (!line) {
          callback(undefined);
          return;
        }
        for (let column = 0; column < line.length; column++) {
          const cell = line.getCell(column);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || " ";
          for (let i = 0; i < chars.length; i++)
            cells.push({
              start: { x: column + 1, y: row + 1 },
              end: { x: column + cell.getWidth(), y: row + 1 },
            });
          text += chars;
        }
        if (text.length > 8192) {
          callback(undefined);
          return;
        }
      }
      const links: ILink[] = [];
      for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
        const value = terminalWebLink(match[0]);
        const start = cells[match.index]?.start,
          end = cells[match.index + match[0].length - 1]?.end;
        if (value && start && end && start.y <= y && end.y >= y)
          links.push({ text: value, range: { start, end }, activate, hover });
      }
      callback(links);
    },
  };
}
