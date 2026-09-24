import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { HostEnvironment } from "@ardurbot/contracts/host-bridge";
import { HOST_TOOLS } from "@ardurbot/contracts/host-bridge";
import { filterHostEnvironment } from "@ardurbot/contracts/host-environment";
import { stripCommandControls } from "@ardurbot/core/command-limits";

export { filterHostEnvironment } from "@ardurbot/contracts/host-environment";

type HostEnvironmentSnapshot = { env: NodeJS.ProcessEnv; diagnostic?: string };
let snapshot: HostEnvironmentSnapshot | undefined;
let capture: Promise<HostEnvironmentSnapshot> | undefined;

export function nativeEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(source
      ? filterHostEnvironment(source, process.platform)
      : (snapshot?.env ?? filterHostEnvironment(process.env, process.platform))),
  };
}

/** Shared by discovery, native runtimes and commands, including concurrent first requests. */
export function getHostEnvironment() {
  capture ??= captureHostEnvironment().then((value) => {
    snapshot = value;
    return value;
  });
  return capture;
}

type ProbeResult = { code: number | null; output: string; failure?: string };

/** Bound time and output even when a profile or CLI never closes its pipes. */
export function hostProbe(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  captureOutput = false,
  timeoutMs = 2_000,
  platform = process.platform,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    let output = "";
    const decoder = new StringDecoder("utf8");
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, failure?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, ...(failure ? { failure } : {}) });
    };
    try {
      child = spawn(binary, args, {
        cwd: env.HOME,
        env,
        shell: false,
        stdio: "pipe",
        windowsHide: true,
        detached: platform !== "win32",
      });
    } catch {
      finish(null, "not started");
      return;
    }
    const stop = (reason: string) => {
      if (settled) return;
      finish(null, reason);
      if (platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    child.once("error", () => finish(null, "not started"));
    child.once("close", (code) => {
      if (captureOutput && !settled) output += decoder.end();
      finish(code);
    });
    child.stdin.on("error", () => stop("not started"));
    child.stdout.on("data", (chunk: Buffer) => {
      if (!captureOutput || settled) return;
      bytes += chunk.length;
      if (bytes > 16 * 1024) stop("output limit");
      else output += decoder.write(chunk);
    });
    child.stderr.resume();
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.stdin.end();
  });
}

function realHome() {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}

/** Exported separately so platform and broken-profile behavior have offline coverage. */
export async function captureHostEnvironment(
  source = process.env,
  platform = process.platform,
  home = realHome(),
): Promise<HostEnvironmentSnapshot> {
  const env = filterHostEnvironment(source, platform);
  env.HOME = home;
  if (platform === "win32") {
    const system = env.SystemRoot ?? env.WINDIR;
    if (system && path.win32.isAbsolute(system)) {
      const registry = path.win32.join(system, "System32", "reg.exe");
      const results = await Promise.all(
        [
          "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
          "HKCU\\Environment",
        ].map((key) =>
          hostProbe(registry, ["query", key, "/v", "Path"], env, true, 2_000, platform),
        ),
      );
      const paths = results
        .map((result) =>
          result.code === 0
            ? result.output.match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1]?.trim()
            : undefined,
        )
        .filter((value): value is string => !!value);
      if (paths.length)
        env.PATH = paths.join(";").replace(/%([^%]+)%/g, (match, name: string) => {
          const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
          return key ? env[key]! : match;
        });
    }
    return { env };
  }
  let shell = env.SHELL;
  if (!shell || !path.posix.isAbsolute(shell)) {
    try {
      shell = userInfo().shell ?? undefined;
    } catch {
      /* Use the platform default. */
    }
  }
  shell =
    shell && path.posix.isAbsolute(shell)
      ? shell
      : platform === "darwin"
        ? "/bin/zsh"
        : "/bin/bash";
  env.SHELL = shell;
  // NUL framing discards profile banners without ever accepting the profile's environment.
  const result = await hostProbe(
    shell,
    ["-lc", 'printf "\\0%s\\0" "$PATH"'],
    env,
    true,
    3_000,
    platform,
  );
  const loginPath = result.output.match(/\0([^\0]+)\0/)?.[1];
  if (result.code === 0 && !result.failure && loginPath?.trim()) {
    env.PATH = loginPath;
    return { env };
  }
  env.PATH = [
    ...new Set(
      [
        ...(env.PATH ?? "").split(":"),
        ...(platform === "darwin" ? ["/opt/homebrew/bin"] : ["/usr/local/sbin"]),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].filter(Boolean),
    ),
  ].join(":");
  const exit = result.failure ?? result.code ?? "signal";
  return {
    env,
    diagnostic: `Your login shell profile failed to load (${redactHostStatus(path.basename(shell))}, exit ${exit}); commands run with a default PATH`,
  };
}

/** Callers provide a name, never an executable path. Symlinked package-manager binaries work. */
export function hostBinaryCandidates(
  name: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform,
) {
  if (!name || /[/\\:\0\r\n]/u.test(name) || name === "." || name === "..") return [];
  const paths = platform === "win32" ? path.win32 : path.posix;
  return (env.PATH ?? "")
    .split(paths.delimiter)
    .filter((directory) => paths.isAbsolute(directory))
    .map((directory) =>
      paths.join(directory, platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name),
    );
}

export async function resolveHostBinary(
  name: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform,
) {
  for (const candidate of hostBinaryCandidates(name, env, platform)) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return await realpath(candidate);
    } catch {
      /* Try the next absolute directory in the owner's PATH. */
    }
  }
  return undefined;
}

export function redactHostStatus(value: string) {
  return stripCommandControls(value)
    .split(/[\r\n]/, 1)[0]!
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+/g, "[email]")
    .replace(/(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\t/g, " ")
    .trim()
    .slice(0, 160);
}

/** Each run probes status once; Settings only needs local executable discovery. */
export async function inspectHostEnvironment(
  captured = getHostEnvironment(),
  checkStatus = true,
): Promise<HostEnvironment> {
  const { env, diagnostic } = await captured;
  const tools: HostEnvironment["tools"] = [];
  for (const name of HOST_TOOLS) {
    const binary = await resolveHostBinary(name, env);
    if (!binary) continue;
    const tool: HostEnvironment["tools"][number] = { name, status: "not checked" };
    if (checkStatus && name === "gh") {
      const version = await hostProbe(binary, ["--version"], env, true);
      if (version.code === 0) tool.version = version.output.match(/\b\d+\.\d+(?:\.\d+)?\b/)?.[0];
      const auth = await hostProbe(binary, ["auth", "status"], env);
      if (!auth.failure && auth.code === 0) tool.status = "signed in";
    } else if (checkStatus && name === "kubectl") {
      const context = await hostProbe(binary, ["config", "current-context"], env, true);
      if (context.code === 0 && !context.failure)
        tool.context = redactHostStatus(context.output) || undefined;
    }
    tools.push(tool);
  }
  return { tools, ...(diagnostic ? { diagnostic } : {}) };
}
