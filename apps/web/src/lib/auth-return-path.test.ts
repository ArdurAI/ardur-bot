import { expect, it } from "vitest";
import { authReturnPath } from "./auth-return-path.js";

it("preserves authenticated block-link destinations without permitting external redirects", () => {
  expect(authReturnPath("/commands/run-1/command-1?space=space-1")).toBe(
    "/commands/run-1/command-1?space=space-1",
  );
  expect(authReturnPath("/onboarding")).toBe("/onboarding");
  expect(authReturnPath("/integrations/setup")).toBe("/integrations/setup");
  expect(authReturnPath("/app/bot-123")).toBe("/app/bot-123");
  expect(authReturnPath("/app/g/group-1")).toBe("/app/g/group-1");
  expect(authReturnPath("/app?view=board")).toBe("/app?view=board");
  for (const next of [
    "https://example.test",
    "http://example.test",
    "//example.test",
    "///example.test",
    "////example.test",
    "/\\example.test",
    "\\example.test",
    "\\\\example.test",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "/apple",
    "/application",
    "/app//evil",
    "/app/\\evil",
    "/app@evil.com",
    "/app/..",
    "/app/../evil",
    "/app/./evil",
    "/app\tevil",
    "/app\nevil",
    "/app?view=//evil.com",
    "/app?next=https://evil.com",
    "/commands/run/x?space=s&next=evil",
    "/commands/\\evil/x",
    "/commands/run/x/extra",
    "/onboarding/extra",
    "/integrations/setup/extra",
    "",
    "   ",
  ])
    expect(authReturnPath(next)).toBe("/app");
  expect(authReturnPath(null)).toBe("/app");
});
