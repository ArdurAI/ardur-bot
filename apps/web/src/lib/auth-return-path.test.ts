import { expect, it } from "vitest";
import { authReturnPath } from "./auth-return-path.js";

it("preserves authenticated block-link destinations without permitting external redirects", () => {
  expect(authReturnPath("/commands/run-1/command-1?space=space-1")).toBe(
    "/commands/run-1/command-1?space=space-1",
  );
  expect(authReturnPath("/onboarding")).toBe("/onboarding");
  expect(authReturnPath("/guided-onboarding?step=finish")).toBe("/guided-onboarding?step=finish");
  expect(authReturnPath("/integrations/setup")).toBe("/integrations/setup");
  expect(authReturnPath("/integrations/setup?mode=mcp")).toBe("/integrations/setup?mode=mcp");
  expect(authReturnPath("/mcp/oauth/callback?code=sample&state=local-state")).toBe(
    "/mcp/oauth/callback?code=sample&state=local-state",
  );
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
    "/app/%2e%2e/evil",
    "/app/.%2E/evil",
    "/app\tevil",
    "/app\nevil",
    "/app?view=//evil.com",
    "/app?next=https://evil.com",
    "/commands/run/x?space=s&next=evil",
    "/commands/\\evil/x",
    "/commands/run/x/extra",
    "/commands/../evil",
    "/commands/%2e%2e/evil",
    "/onboarding/extra",
    "/guided-onboarding?step=//evil.test",
    "/guided-onboarding?step=model&next=evil",
    "/integrations/setup/extra",
    "/integrations/setup?mode=//external.test",
    "/mcp/oauth/callback/../evil?code=sample",
    "/mcp/oauth/callback?code=sample\\evil",
    "/mcp/oauth/callback?code=sample\nevil",
    "",
    "   ",
  ])
    expect(authReturnPath(next)).toBe("/app");
  expect(authReturnPath(null)).toBe("/app");
});
