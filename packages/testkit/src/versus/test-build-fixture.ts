import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A self-contained Git repository for build identity in tests, so they never depend on this
 * checkout's history. Pair it with a mock of `RESEARCH_BASELINE` as `refs/tags/research-baseline`.
 */
export async function createBuildFixture() {
  const repository = await fs.mkdtemp(path.join(tmpdir(), "versus-build-fixture-"));
  const sources = path.join(repository, "packages/testkit/src/versus");
  await fs.mkdir(sources, { recursive: true });
  await fs.writeFile(path.join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const source = path.join(sources, "fixture.ts");
  await fs.writeFile(source, 'export const revision = "baseline";\n');
  const git = (...args: string[]) =>
    childProcess.execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: repository, stdio: "ignore" },
    );
  git("init");
  git("add", ".");
  git("commit", "-m", "Research baseline fixture");
  git("update-ref", "refs/tags/research-baseline", "HEAD");
  await fs.writeFile(source, 'export const revision = "candidate";\n');
  git("commit", "-am", "Candidate fixture");
  return repository;
}
