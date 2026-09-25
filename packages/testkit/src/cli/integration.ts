import { runProcess } from "./process.js";

type SuiteFailure = { phase: "setup" | "test" | "cleanup"; message: string };

export async function runIntegrationSuites(options: {
  suites: string[];
  databaseUrl: string;
  template: string;
  databaseCommand: (statement: string) => Promise<void>;
  env: NodeJS.ProcessEnv;
}) {
  const results: Array<{ suite: string; failures: SuiteFailure[] }> = [];
  const template = options.template.replaceAll('"', '""');
  for (const [index, suite] of options.suites.entries()) {
    const database = `integration_${index}`;
    const suiteUrl = new URL(options.databaseUrl);
    suiteUrl.pathname = `/${database}`;
    const failures: SuiteFailure[] = [];
    let phase: SuiteFailure["phase"] = "setup";
    try {
      await options.databaseCommand(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
      phase = "test";
      await runProcess("pnpm", ["exec", "vitest", "run", suite], {
        ...options.env,
        DATABASE_URL: suiteUrl.toString(),
        REALTIME_DATABASE_URL: suiteUrl.toString(),
        OPENROUTER_API_KEY: "",
        MODEL_API_KEY: "",
      });
    } catch (error) {
      failures.push({ phase, message: error instanceof Error ? error.message : String(error) });
    } finally {
      try {
        await options.databaseCommand(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      } catch (error) {
        failures.push({
          phase: "cleanup",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    results.push({ suite, failures });
  }

  const failed = results.filter((result) => result.failures.length > 0);
  console.log(
    `Integration suites: ${results.length - failed.length} passed, ${failed.length} failed`,
  );
  for (const { suite, failures } of results) {
    console.log(`${failures.length ? "FAIL" : "PASS"} ${suite}`);
    for (const { phase, message } of failures) console.error(`  ${phase}: ${message}`);
  }
  return { ok: failed.length === 0, suites: results };
}
