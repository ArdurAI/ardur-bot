import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("lists eval cases without importing database, runtime, or container dependencies", () => {
  const guard = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (['@ardurbot/db', '@ardurbot/adapters', '@testcontainers/postgresql'].includes(specifier)) {
          throw new Error('Live dependencies imported while listing eval cases');
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(guard)}`,
      path.resolve(import.meta.dirname, "../cli/evals.ts"),
      "--list",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(output).toContain("workspace-memory-isolation:");
  expect(output.trim().split("\n")).toHaveLength(16);
});
