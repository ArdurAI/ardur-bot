import { describe, expect, it } from "vitest";
import { ideShortcut, quickMatches, scanFiles, todayRange } from "./model";

describe("IDE quick open and keys", () => {
  it("walks once per directory, matches file names and cancels between directories", async () => {
    const seen: string[] = [],
      received: string[] = [];
    const abort = new AbortController();
    await expect(
      scanFiles(
        async (path) => {
          seen.push(path);
          if (path === "src") abort.abort();
          return [
            { path: "src", kind: "dir", size: 0 },
            { path: `${path || "root"}/file.ts`, kind: "file", size: 10 },
          ];
        },
        abort.signal,
        (files) => received.push(...files.map((file) => file.path)),
      ),
    ).rejects.toThrow();
    expect(seen).toEqual(["", "src"]);
    expect(received).toEqual(["root/file.ts"]);
    expect(quickMatches([{ path: "folder/Test.TS", kind: "file", size: 0 }], "test")).toHaveLength(
      1,
    );
    expect(
      quickMatches([{ path: "folder/Test.TS", kind: "file", size: 0 }], "folder"),
    ).toHaveLength(0);
  });
  it.each(["ctrlKey", "metaKey"] as const)("uses %s for each required shortcut", (modifier) => {
    const key = (key: string, shiftKey = false, code = "") =>
      ideShortcut({
        key,
        code,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey,
        [modifier]: true,
      });
    expect([key("s"), key("p"), key("f"), key("A", true), key("`", false, "Backquote")]).toEqual([
      "save",
      "open",
      "find",
      "ask",
      "terminal",
    ]);
  });
  it("uses the person's local calendar day", () => {
    const date = new Date(2026, 0, 2, 23, 59);
    const range = todayRange(date);
    expect(new Date(range.since).getDate()).toBe(2);
    expect(new Date(range.since).getHours()).toBe(0);
    expect(new Date(range.until).getDate()).toBe(3);
  });
});
