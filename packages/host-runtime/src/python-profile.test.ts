import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const python = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 5000 });

if (python.error && "code" in python.error && python.error.code === "ENOENT") {
  it.skip("Python profile tests skipped: system python3 is absent", () => {});
} else {
  it("runs the offline Hermes profile Python unit tests", () => {
    const tests = fileURLToPath(new URL("../python/tests", import.meta.url));
    const result = spawnSync(
      "python3",
      ["-B", "-m", "unittest", "discover", "-s", tests, "-p", "*test.py"],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran \d+ tests/);
  });
}
