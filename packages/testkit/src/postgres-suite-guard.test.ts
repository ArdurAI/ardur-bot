import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

// These suites require dedicated scoreboard fixtures or instrumentation that the
// ordinary integration harness intentionally does not provide. The associated
// READMEs/documentation give their standalone commands and prerequisites.
const runsElsewhere = [
  "packages/testkit/src/scoreboard/experiments/components.postgres.test.ts", // Heavy matrix; opt-in Docker images, run command in experiments/README.md.
  "packages/testkit/src/scoreboard/faults/process.postgres.test.ts", // Long crash-boundary run; opt-in cached images, run command in experiments/README.md.
  "packages/testkit/src/scoreboard/load/queue.postgres.test.ts", // Load/timing experiment; opt-in cached images, run command in experiments/README.md.
  "packages/testkit/src/scoreboard/replay/production.postgres.test.ts", // Needs provisioned scoreboard trial DB; standalone SCOREBOARD_TEST_DATABASE_URL.
  "packages/testkit/src/scoreboard/replay/services.postgres.test.ts", // Needs provisioned scoreboard trial DB; standalone SCOREBOARD_TEST_DATABASE_URL.
  "packages/testkit/src/scoreboard/trace-production.postgres.test.ts", // Instrumentation trial, not routine acceptance; run command in docs/trace-spans.md.
];

async function postgresSuites(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === ".git" || entry.name === "node_modules") return [];
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory())
        return postgresSuites(path.join(directory, entry.name), childRelative);
      return entry.isFile() && entry.name.endsWith(".postgres.test.ts") ? [childRelative] : [];
    }),
  );
  return files.flat().sort();
}

it("accounts for every PostgreSQL test suite in integration CI or a documented opt-out", async () => {
  const harness = await readFile(
    path.join(repositoryRoot, "packages/testkit/src/cli/harness.ts"),
    "utf8",
  );
  const suiteBlock = harness.match(/const suites = \[([\s\S]*?)\n\s*\];/)?.[1];
  expect(suiteBlock, "integration harness suite list").toBeDefined();
  const inHarness = [...suiteBlock!.matchAll(/"([^"]+\.postgres\.test\.ts)"/g)].map(
    (match) => match[1]!,
  );
  const files = await postgresSuites(repositoryRoot);
  const exceptions = new Set(runsElsewhere);
  const accounted = new Set([...inHarness, ...exceptions]);

  expect(new Set(inHarness).size, "duplicate integration suite paths").toBe(inHarness.length);
  expect(exceptions.size, "duplicate runs-elsewhere paths").toBe(runsElsewhere.length);
  expect([...inHarness, ...runsElsewhere].filter((suite) => !files.includes(suite))).toEqual([]);
  expect(files.filter((suite) => !accounted.has(suite))).toEqual([]);
});
