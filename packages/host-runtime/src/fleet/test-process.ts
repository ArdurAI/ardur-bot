import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LINUX_EXEC_SCRIPT } from "./linux-scripts.js";
import type { FleetProcess } from "./process.js";

/** Offline transport: real Python file/archive scripts and a local process instead of a network. */
export async function fakeSshTransport() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ardurbot-ssh-test-")));
  const calls: { name: string; argv: string[] }[] = [];
  const words = (command: string): string[] =>
    JSON.parse(
      execFileSync(
        "python3",
        ["-c", "import shlex,json,sys; print(json.dumps(shlex.split(sys.argv[1])))", command],
        { encoding: "utf8" },
      ),
    );
  const processes: FleetProcess = {
    async start(name, argv) {
      calls.push({ name, argv });
      if (name !== "ssh") throw new Error("Unexpected test process");
      const remote = words(argv.at(-1)!);
      // macOS has no /proc; only the process birth marker is supplied by the fake.
      if (process.platform !== "linux" && remote[2] === LINUX_EXEC_SCRIPT)
        remote[2] = remote[2].replace(
          "start=open('/proc/'+marker+'/stat').read().split(') ',1)[1].split()[19]",
          "start='0'",
        );
      return spawn(remote[0]!, remote.slice(1), { stdio: "pipe", detached: true });
    },
    async run(name, argv, signal, input, limit = 16 * 1024 * 1024) {
      if (name === "sftp") {
        calls.push({ name, argv });
        const batch = Buffer.from(input!).toString();
        const [operation, source, target] = words(batch);
        if (!["get", "put"].includes(operation!)) throw new Error("Unexpected test transfer");
        await copyFile(source!, target!);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
      }
      const child = await this.start(name, argv);
      return new Promise((resolve, reject) => {
        const output: Buffer[] = [],
          error: Buffer[] = [];
        let size = 0;
        const abort = () => child.kill("SIGKILL");
        signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (bytes: Buffer) => {
          output.push(bytes);
          size += bytes.length;
          if (size > limit) {
            abort();
            reject(new Error("Test output exceeds limit"));
          }
        });
        child.stderr.on("data", (bytes: Buffer) => error.push(bytes));
        child.once("error", reject);
        child.once("close", (code) => {
          signal.removeEventListener("abort", abort);
          resolve({ stdout: Buffer.concat(output), stderr: Buffer.concat(error), code: code ?? 1 });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
      });
    },
  };
  return { root, processes, calls, close: () => rm(root, { recursive: true, force: true }) };
}
