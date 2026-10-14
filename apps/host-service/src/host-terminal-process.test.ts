import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { darwinProcessSnapshot } from "./host-terminal-pty.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const execute = vi.mocked(execFile);
afterEach(() => vi.resetAllMocks());

function lookup(stdout: string, error: Error | null = null) {
  execute.mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string) => void;
    callback(error, stdout);
    return {} as ReturnType<typeof execFile>;
  });
}
it("looks up numeric ancestry and birth metadata with bounded time and output, without inherited secrets", async () => {
  lookup(" 100 1 100 Ss Thu Oct 14 10:00:00 2026\n 101 100 101 Z Thu Oct 14 10:00:01 2026\n");
  await expect(darwinProcessSnapshot(200)).resolves.toEqual([
    { pid: 100, parent: 1, group: 100, birth: "Thu Oct 14 10:00:00 2026", zombie: false },
    { pid: 101, parent: 100, group: 101, birth: "Thu Oct 14 10:00:01 2026", zombie: true },
  ]);
  expect(execute).toHaveBeenCalledWith(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
    { timeout: 200, maxBuffer: 2 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
    expect.any(Function),
  );
});
it("refuses malformed metadata rather than treating the omitted process as dead", async () => {
  lookup("truncated metadata\n");
  await expect(darwinProcessSnapshot(200)).rejects.toThrow("Invalid terminal process lookup");
});
it("reports a fixed error instead of propagating process-tool output", async () => {
  lookup("private fixture output", new Error("private fixture error"));
  await expect(darwinProcessSnapshot(200)).rejects.toThrow(/^Terminal process lookup failed\.$/);
});
