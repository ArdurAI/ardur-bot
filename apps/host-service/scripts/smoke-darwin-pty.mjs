import { createRequire } from "node:module";
import path from "node:path";

/** Runs on macOS in both host-service and desktop builds, before packaging. */
export async function smokeDarwinPty(directory) {
  if (process.platform !== "darwin") return;
  const require = createRequire(path.join(directory, "host-service.cjs"));
  const pty = require(path.join(directory, "native", `mac_${process.arch}`, "node-pty"));
  const child = pty.spawn("/bin/echo", ["pty-smoke"], {
    cwd: directory,
    env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const data = child.onData((text) => {
      output += text;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      data.dispose();
      exit.dispose();
      reject(new Error("Staged macOS PTY smoke timed out."));
    }, 5000);
    const exit = child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      data.dispose();
      exit.dispose();
      if (exitCode !== 0 || !output.includes("pty-smoke"))
        reject(new Error("Staged macOS PTY smoke failed."));
      else resolve();
    });
  });
}
