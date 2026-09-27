import { writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { runIntegrationSuites } from "./integration.js";
import { runProcess } from "./process.js";

vi.mock("./process.js", () => ({ runProcess: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function fixture() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const operations: string[] = [];
  const databaseCommand = vi.fn(async (statement: string) => {
    operations.push(statement);
  });
  vi.mocked(runProcess).mockImplementation(async (_command, args) => {
    operations.push(args.at(-1)!);
  });
  return {
    log,
    error,
    operations,
    options: {
      suites: ["first.test.ts", "second.test.ts", "third.test.ts"],
      databaseUrl: "postgresql://fixture:fixture@localhost:5432/test",
      template: 'test"template',
      databaseCommand,
      env: { CI: "1", OPENROUTER_API_KEY: "unused-fixture", MODEL_API_KEY: "unused-fixture" },
    },
  };
}

it("runs and cleans every isolated suite and reports all test failures", async () => {
  const { options, operations, log, error } = fixture();
  vi.mocked(runProcess).mockImplementation(async (_command, args) => {
    const suite = args.at(-1)!;
    operations.push(suite);
    if (suite !== "second.test.ts") throw new Error(`${suite} exited 1`);
  });

  const result = await runIntegrationSuites(options);

  expect(result).toEqual({
    ok: false,
    suites: [
      { suite: "first.test.ts", failures: [{ phase: "test", message: "first.test.ts exited 1" }] },
      { suite: "second.test.ts", failures: [] },
      { suite: "third.test.ts", failures: [{ phase: "test", message: "third.test.ts exited 1" }] },
    ],
  });
  expect(operations).toEqual(
    options.suites.flatMap((suite, index) => [
      `CREATE DATABASE "integration_${index}" TEMPLATE "test""template"`,
      suite,
      `DROP DATABASE IF EXISTS "integration_${index}" WITH (FORCE)`,
    ]),
  );
  for (const [index, suite] of options.suites.entries()) {
    expect(runProcess).toHaveBeenNthCalledWith(
      index + 1,
      "pnpm",
      ["exec", "vitest", "run", suite],
      {
        CI: "1",
        DATABASE_URL: `postgresql://fixture:fixture@localhost:5432/integration_${index}`,
        REALTIME_DATABASE_URL: `postgresql://fixture:fixture@localhost:5432/integration_${index}`,
        USAGE_LEDGER_TEST_DATABASE_URL: `postgresql://fixture:fixture@localhost:5432/integration_${index}`,
        OPENROUTER_API_KEY: "",
        MODEL_API_KEY: "",
      },
    );
  }
  expect(log).toHaveBeenCalledWith("Integration suites: 1 passed, 2 failed");
  expect(error.mock.calls).toEqual([
    ["  test: first.test.ts exited 1"],
    ["  test: third.test.ts exited 1"],
  ]);
});

it("continues after setup and cleanup failures without losing either cause", async () => {
  const { options } = fixture();
  options.databaseCommand.mockImplementation(async (statement) => {
    if (statement.startsWith('CREATE DATABASE "integration_0"')) throw new Error("setup failed");
    if (statement.startsWith('DROP DATABASE IF EXISTS "integration_0"'))
      throw new Error("setup cleanup failed");
    if (statement.startsWith('DROP DATABASE IF EXISTS "integration_1"'))
      throw new Error("test cleanup failed");
  });
  vi.mocked(runProcess).mockRejectedValueOnce(new Error("test failed"));

  const result = await runIntegrationSuites(options);

  expect(result).toEqual({
    ok: false,
    suites: [
      {
        suite: "first.test.ts",
        failures: [
          { phase: "setup", message: "setup failed" },
          { phase: "cleanup", message: "setup cleanup failed" },
        ],
      },
      {
        suite: "second.test.ts",
        failures: [
          { phase: "test", message: "test failed" },
          { phase: "cleanup", message: "test cleanup failed" },
        ],
      },
      { suite: "third.test.ts", failures: [] },
    ],
  });
  expect(runProcess).toHaveBeenCalledTimes(2);
  expect(options.databaseCommand).toHaveBeenCalledTimes(6);
});

it("reports success only when every suite and cleanup succeeds", async () => {
  const { options, log } = fixture();
  expect(await runIntegrationSuites(options)).toEqual({
    ok: true,
    suites: options.suites.map((suite) => ({ suite, failures: [] })),
  });
  expect(log).toHaveBeenCalledWith("Integration suites: 3 passed, 0 failed");
});

it("fails an integration filter that executes no tests", async () => {
  const { options, log, error } = fixture();
  options.suites = ["first.test.ts"];
  const filtered = { ...options, testNamePattern: "missing test" };
  vi.mocked(runProcess).mockImplementation(async (_command, args) => {
    const output = args.find((arg) => arg.startsWith("--outputFile.json="))?.split("=")[1];
    if (!output) throw new Error("JSON report path missing");
    await writeFile(output, JSON.stringify({ numPassedTests: 0 }));
  });

  const result = await runIntegrationSuites(filtered);

  expect(result).toEqual({
    ok: false,
    suites: [
      {
        suite: "first.test.ts",
        failures: [{ phase: "test", message: "No tests matched integration filter: missing test" }],
      },
    ],
  });
  expect(vi.mocked(runProcess).mock.calls[0]?.[1]).toContain("--testNamePattern");
  expect(log).toHaveBeenCalledWith("Integration suites: 0 passed, 1 failed");
  expect(error).toHaveBeenCalledWith("  test: No tests matched integration filter: missing test");
});

it("counts both repeated runs when the filter matches", async () => {
  const { options, log } = fixture();
  options.suites = ["first.test.ts", "first.test.ts"];
  const filtered = { ...options, testNamePattern: "selected test" };
  vi.mocked(runProcess).mockImplementation(async (_command, args) => {
    const output = args.find((arg) => arg.startsWith("--outputFile.json="))?.split("=")[1];
    if (!output) throw new Error("JSON report path missing");
    await writeFile(output, JSON.stringify({ numPassedTests: 1 }));
  });

  expect(await runIntegrationSuites(filtered)).toEqual({
    ok: true,
    suites: options.suites.map((suite) => ({ suite, failures: [] })),
  });
  expect(runProcess).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith("Integration suites: 2 passed, 0 failed");
});
