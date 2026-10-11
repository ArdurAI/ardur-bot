import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("opens a board result link on the named goal and revision, outside the initial shell", () => {
  const shell = readFileSync(fileURLToPath(new URL("./Shell.tsx", import.meta.url)), "utf8");
  expect(shell).toContain('import("./GoalNamedResult")');
  expect(shell).not.toMatch(/from\s+["']\.\/GoalNamedResult["']/);
  const named = readFileSync(
    fileURLToPath(new URL("./GoalNamedResult.tsx", import.meta.url)),
    "utf8",
  );
  expect(named).toContain("goals.revision");
  expect(named).toContain("recordedResult");
});
