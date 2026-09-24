import { expect, it } from "vitest";
import { authReturnPath } from "./auth-return-path.js";

it("preserves authenticated block-link destinations without permitting external redirects", () => {
  expect(authReturnPath("/commands/run-1/command-1?space=space-1")).toBe(
    "/commands/run-1/command-1?space=space-1",
  );
  for (const next of [
    "https://example.test",
    "//example.test",
    "/commands/run/x?space=s&next=evil",
    "/commands/\\evil/x",
  ])
    expect(authReturnPath(next)).toBe("/app");
});
