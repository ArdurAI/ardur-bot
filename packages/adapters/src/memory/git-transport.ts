import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { MarkdownFiles } from "./markdown-files.js";

export type GitCredential = { kind: "token" | "ssh"; value: string };
export interface GitRemote {
  url: string;
  host: string;
  protocol: "https" | "ssh" | "fixture";
}
export function validateGitRemote(
  value: string,
  allowedHosts: readonly string[] = ["github.com"],
): GitRemote {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter an HTTPS or SSH repository URL.");
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    (url.username && !(url.protocol === "ssh:" && url.username === "git")) ||
    url.port ||
    url.search ||
    url.hash ||
    value !== value.trim() ||
    !/^\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(url.pathname) ||
    /%|\.\.|[\r\n\\]/u.test(value) ||
    !allowedHosts.includes(url.hostname)
  )
    throw new Error("Use a repository on an allowed host without credentials in its URL.");
  if (url.protocol === "ssh:" && url.username !== "git")
    throw new Error("Use an SSH repository URL starting with ssh://git@.");
  return {
    url: url.href,
    host: url.hostname,
    protocol: url.protocol === "https:" ? "https" : "ssh",
  };
}
export function validateGitBranch(branch: string): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,180}$/u.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  )
    throw new Error("Enter a valid branch name.");
  return branch;
}
export class GitOperationError extends Error {
  constructor(readonly code: number | null = null) {
    super("Could not sync the repository. Check the connection and retry.");
  }
}
export interface GitTransportOptions {
  root: string;
  remote: GitRemote;
  credential?: () => Promise<GitCredential>;
  /** Deployment-owned trust file. Never read the user's SSH configuration. */
  knownHosts?: string;
  /** Only offline fixture constructors may enable local transport. */
  allowFixtureRemote?: boolean;
  observe?: (argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>) => void;
}
const GITHUB_HOST_KEY =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
const MAX_OUTPUT = 64_000_000;

/** The only process boundary. No inherited credentials, shell, hooks, user config or raw errors. */
export class GitTransport {
  readonly files: MarkdownFiles;
  readonly control: MarkdownFiles;
  constructor(readonly options: GitTransportOptions) {
    if (options.remote.protocol === "fixture" && !options.allowFixtureRemote)
      throw new GitOperationError();
    this.files = new MarkdownFiles(path.join(options.root, "clone"));
    this.control = new MarkdownFiles(options.root);
  }
  private environment(): NodeJS.ProcessEnv {
    const empty = path.join(this.options.root, "empty");
    return {
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/local/bin"].join(
        path.delimiter,
      ),
      HOME: empty,
      XDG_CONFIG_HOME: empty,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_LITERAL_PATHSPECS: "1",
    };
  }
  private argv(args: readonly string[]): string[] {
    return [
      "-c",
      `core.hooksPath=${path.join(this.options.root, "empty")}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "filter.ardur.clean=",
      "-c",
      "filter.ardur.smudge=",
      "-c",
      "filter.ardur.process=",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "fetch.fsckObjects=true",
      "-c",
      "transfer.fsckObjects=true",
      "-c",
      "protocol.allow=never",
      "-c",
      `protocol.${this.options.remote.protocol === "fixture" ? "file" : this.options.remote.protocol}.allow=always`,
      "-c",
      "http.followRedirects=false",
      "-c",
      "http.sslVerify=true",
      "-c",
      "http.proxy=",
      "-c",
      "submodule.recurse=false",
      ...args,
    ];
  }
  async initialize() {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    await this.control.validateRoot();
    await this.control.ensureDirectory("empty");
    await this.control.ensureDirectory("clone");
    const gitDir = new MarkdownFiles(path.join(this.files.root, ".git"));
    try {
      await gitDir.validateRoot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.run(["init", "--quiet", "--template=", "--initial-branch=ardur-local"], {
        unchecked: true,
      });
    }
    await gitDir.validateRoot();
    // Local config is app-owned and never taken from a fetched tree.
    await gitDir.write("config", "[core]\nrepositoryformatversion = 0\nbare = false\n", false);
    await gitDir.write("info/attributes", "* -filter -diff -merge -text\n", false);
  }
  async run(
    args: readonly string[],
    options: {
      input?: string;
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
      unchecked?: boolean;
    } = {},
  ): Promise<string> {
    return (await this.runBytes(args, options)).toString("utf8");
  }
  async runBytes(
    args: readonly string[],
    options: {
      input?: string;
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
      unchecked?: boolean;
    } = {},
  ): Promise<Buffer> {
    if (options.signal?.aborted) throw new GitOperationError();
    if (!options.unchecked)
      await new MarkdownFiles(path.join(this.files.root, ".git")).validateRoot();
    const argv = this.argv(args);
    const env = { ...this.environment(), ...options.env };
    this.options.observe?.(argv, env);
    return new Promise((resolve, reject) => {
      const child = spawn("git", argv, {
        cwd: this.files.root,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stopped = false;
      const stop = () => {
        stopped = true;
        // Kill the entire process group, including credential/SSH helpers, before releasing locks.
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* Already exited. */
        }
      };
      const timeout = setTimeout(stop, 30_000);
      options.signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (data: Buffer) => {
        chunks.push(data);
        bytes += data.length;
        if (bytes > MAX_OUTPUT) stop();
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input ?? "");
      child.once("error", () => {
        stopped = true;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", stop);
        if (code === 0 && !stopped) resolve(Buffer.concat(chunks));
        else reject(new GitOperationError(code));
      });
    });
  }
  private async authenticated<T>(
    signal: AbortSignal,
    action: (env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    if (this.options.remote.protocol === "fixture") return action({});
    const credential = await this.options.credential?.();
    if (!credential || (credential.kind === "token") !== (this.options.remote.protocol === "https"))
      throw new GitOperationError();
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "ardur-git-")));
    await chmod(temporary, 0o700);
    const helper = path.join(temporary, "helper");
    let cleanup = async () => {};
    try {
      if (credential.kind === "token") {
        const socketPath = path.join(temporary, "credential.sock");
        const server = createServer((socket) => {
          socket.setTimeout(1000, () => socket.destroy());
          socket.once("data", (data) =>
            socket.end(data.toString() === "username" ? "x-access-token" : credential.value),
          );
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        cleanup = () => new Promise<void>((resolve) => server.close(() => resolve()));
        await writeFile(
          helper,
          `#!${process.execPath}\nconst net = require('node:net');\nconst socket = net.connect(${JSON.stringify(socketPath)});\nsocket.on('connect', () => socket.write((process.argv[2] || '').startsWith('Username') ? 'username' : 'password'));\nsocket.on('data', data => process.stdout.write(data));\nsocket.on('error', () => process.exit(1));\n`,
          { mode: 0o700 },
        );
        return await action({ GIT_ASKPASS: helper });
      }
      const keyPath = path.join(temporary, "identity");
      await writeFile(keyPath, `${credential.value.trim()}\n`, { mode: 0o600 });
      const hostsPath = this.options.knownHosts ?? path.join(temporary, "known_hosts");
      if (!this.options.knownHosts) await writeFile(hostsPath, GITHUB_HOST_KEY, { mode: 0o600 });
      const sshArgs = [
        "-F",
        "/dev/null",
        "-i",
        keyPath,
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${hostsPath}`,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ProxyCommand=none",
        "-o",
        "ConnectTimeout=10",
      ];
      await writeFile(
        helper,
        `#!${process.execPath}\nconst {spawnSync} = require('node:child_process');\nconst result = spawnSync('ssh', [...${JSON.stringify(sshArgs)}, ...process.argv.slice(2)], {stdio: 'inherit', env: process.env, shell: false});\nprocess.exit(result.status ?? 1);\n`,
        { mode: 0o700 },
      );
      if (signal.aborted) throw new GitOperationError();
      return await action({ GIT_SSH: helper, GIT_SSH_VARIANT: "ssh" });
    } catch {
      throw new GitOperationError();
    } finally {
      await cleanup();
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async fetch(branch: string, signal: AbortSignal): Promise<string | null> {
    validateGitBranch(branch);
    return this.authenticated(signal, async (env) => {
      const output = await this.run(
        ["ls-remote", "--heads", "--", this.options.remote.url, `refs/heads/${branch}`],
        { env, signal },
      );
      if (!output.trim()) return null;
      const oid = output.split(/\s/u)[0]!;
      if (!/^[a-f0-9]{40,64}$/u.test(oid)) throw new GitOperationError();
      await this.run(
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          "--",
          this.options.remote.url,
          `refs/heads/${branch}`,
        ],
        { env, signal },
      );
      // Fetch the advertised object by ref above, then verify the advertised tip is present.
      await this.run(["cat-file", "-e", `${oid}^{commit}`], { signal });
      return oid;
    });
  }
  async push(oid: string, branch: string, signal: AbortSignal) {
    validateGitBranch(branch);
    if (!/^[a-f0-9]{40,64}$/u.test(oid)) throw new GitOperationError();
    await this.authenticated(signal, (env) =>
      this.run(
        [
          "push",
          "--porcelain",
          "--no-verify",
          "--",
          this.options.remote.url,
          `${oid}:refs/heads/${branch}`,
        ],
        { env, signal },
      ),
    );
  }
  async ancestor(before: string, after: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.run(["merge-base", "--is-ancestor", before, after], { signal });
      return true;
    } catch (error) {
      if (error instanceof GitOperationError && error.code === 1) return false;
      throw error;
    }
  }
}
