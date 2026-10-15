import type { IBuffer, ILink } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { terminalLinkProvider } from "./links.js";

it("maps a wrapped URL after a wide character and never opens it during detection", () => {
  const rows = [["界", "", " ", ..."https://example."], [..."test/path"]];
  const buffer = {
    getLine: (row: number) =>
      rows[row]
        ? {
            isWrapped: row === 1,
            length: rows[row]!.length,
            getCell: (column: number) => ({
              getChars: () => rows[row]![column]!,
              getWidth: () => (rows[row]![column] === "" ? 0 : rows[row]![column] === "界" ? 2 : 1),
            }),
          }
        : undefined,
  } as unknown as IBuffer;
  const activate = vi.fn(),
    hover = vi.fn();
  const links: ILink[] = [];
  terminalLinkProvider(() => buffer, activate, hover).provideLinks(2, (found) =>
    links.push(...(found ?? [])),
  );
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({
    text: "https://example.test/path",
    range: { start: { x: 4, y: 1 }, end: { x: 9, y: 2 } },
  });
  expect(activate).not.toHaveBeenCalled();
  expect(hover).not.toHaveBeenCalled();
});
