import { describe, expect, it } from "vitest";
import { closeUnterminatedFence, nativeCursorProps, sanitizeMarkdownUrl } from "./markdown";

describe("sanitizeMarkdownUrl", () => {
  it("allows normal external links and optionally allows local links", () => {
    expect(sanitizeMarkdownUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(sanitizeMarkdownUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(sanitizeMarkdownUrl("/docs", true)).toBe("/docs");
    expect(sanitizeMarkdownUrl("#section", true)).toBe("#section");
  });

  it("rejects executable and embedded-data URLs", () => {
    expect(sanitizeMarkdownUrl("javascript:alert(1)", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("data:text/html,<script>alert(1)</script>", true)).toBeUndefined();
    expect(sanitizeMarkdownUrl("/docs")).toBeUndefined();
  });
});

describe("closeUnterminatedFence", () => {
  it("temporarily closes a partial streaming code fence", () => {
    expect(closeUnterminatedFence("Before\n```ts\nconst value = 1;")).toBe(
      "Before\n```ts\nconst value = 1;\n```",
    );
  });

  it("leaves complete markdown unchanged", () => {
    const markdown = "```ts\nconst value = 1;\n```\n\nDone";
    expect(closeUnterminatedFence(markdown)).toBe(markdown);
  });
});

describe("nativeCursorProps", () => {
  it("shows the cursor in the given color while the reply text grows", () => {
    expect(nativeCursorProps({ streaming: true }, "muted-foreground")).toEqual({
      cursorColor: "muted-foreground",
    });
    expect(nativeCursorProps({ streaming: true, cursor: true }, "muted-foreground")).toEqual({
      cursorColor: "muted-foreground",
    });
  });

  it("hides a paused cursor by color only, so its box keeps its space", () => {
    // No size or style override: the cursor keeps its layout box, drawn transparent.
    expect(nativeCursorProps({ streaming: true, cursor: false }, "muted-foreground")).toEqual({
      cursorColor: "transparent",
    });
  });
});
