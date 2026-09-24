import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("checks live page browser protocol failure handling offline", () => {
  const tests = fileURLToPath(new URL("../../computer/test_page_browser.py", import.meta.url));
  // Allow interpreter startup under full-suite load; protocol checks keep their own bounds.
  expect(() => execFileSync("python3", [tests], { timeout: 30_000, stdio: "pipe" })).not.toThrow();
});
