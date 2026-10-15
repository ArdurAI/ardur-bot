const path = require("node:path");

// Run with Electron's embedded Node in CI after staging, outside the application archive.
const platform = process.platform === "win32" ? "win" : "linux";
const root = path.resolve(__dirname, "../dist/native", `${platform}_${process.arch}`, "node-pty");
const pty = require(root);
const windows = process.platform === "win32";
const child = pty.spawn(
  windows ? "cmd.exe" : "/bin/sh",
  windows ? ["/d", "/q", "/c", "echo pty-smoke"] : ["-c", "printf 'pty-smoke\\n'"],
  {
    cwd: path.dirname(root),
    env: windows
      ? { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }
      : { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
    ...(windows ? { useConpty: true, useConptyDll: true } : {}),
  },
);
let output = "";
child.onData((text) => {
  output += text;
});
const timer = setTimeout(() => {
  child.kill();
  throw new Error("Staged PTY smoke timed out.");
}, 5000);
child.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (windows) {
    child._agent._inSocket.destroy();
    child._agent._outSocket.destroy();
    void child._agent._conoutSocketWorker._worker.terminate();
  }
  if (exitCode !== 0 || !output.includes("pty-smoke")) throw new Error("Staged PTY smoke failed.");
  console.log("Staged PTY loaded in Electron and produced output.");
});
