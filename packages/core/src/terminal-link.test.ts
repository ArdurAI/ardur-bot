import { expect, it } from "vitest";
import { terminalWebLink } from "./terminal-link.js";

it.each(["https://example.test/path?q=1", "http://localhost:3000", "HTTPS://example.test/"])(
  "preserves an explicit web URL: %s",
  (value) => expect(terminalWebLink(value)).toBe(value),
);
it.each([
  "javascript:alert(1)",
  "file:///private/file",
  "data:text/html,hello",
  "//example.test",
  "https:example.test",
  "https://",
  "https:////example.test",
  "https://@example.test",
  "https://user:secret@example.test",
  "https://user@example.test",
  "https://example.test\\path",
  " https://example.test",
  "https://example.test\n",
  "http://localhost:99999",
  `https://example.test/${"x".repeat(8192)}`,
])("rejects an unsafe or malformed URL", (value) => expect(terminalWebLink(value)).toBeNull());
