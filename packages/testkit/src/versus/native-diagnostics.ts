import { execFile } from "node:child_process";
import { readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { contentDigest } from "../scoreboard/manifest.js";
import type { NativePolicy, OwnedDirectory } from "./isolation.js";
import { nativeProfile, prepareEnvironment, proveNativeIsolation } from "./isolation.js";
import { bytesHash, sanitize } from "./provenance.js";

const exec = promisify(execFile);
export interface NativeProbe {
  name: string;
  profileHash: string;
  commandHash: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** A failed positive control is never evidence of protection. No product modules are imported. */
export async function diagnoseNativeIsolation(input: {
  trial: OwnedDirectory;
  outside: OwnedDirectory;
  source: string;
  executable: string;
}) {
  const { trial, outside } = input;
  const policy: NativePolicy = {
    root: trial.root,
    readRoots: [input.source],
    ports: [],
    forbiddenRoots: [outside.root],
  };
  const containment = (await proveNativeIsolation(policy)).result;
  const probes: NativeProbe[] = [];
  if (process.platform !== "darwin")
    return { containment, probes, interpreterHash: null, runtimeCanariesPassed: false };
  // Resolve the installed launcher's sibling interpreter; never execute the Hermes entrypoint.
  const interpreter = await realpath(path.join(path.dirname(input.executable), "python3"));
  const interpreterHash = bytesHash(await readFile(interpreter));
  const env = await prepareEnvironment(trial.state, interpreter);
  const profile = nativeProfile(policy);
  const rootPermission = '(allow file-read* (literal "/"))';
  const sslPermission = '(allow file-read-data (literal "/private/etc/ssl/openssl.cnf"))';
  const run = async (name: string, selected: string, argv: string[]) => {
    const observation: NativeProbe = {
      name,
      profileHash: contentDigest(selected),
      commandHash: contentDigest(argv),
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
    };
    try {
      const result = await exec("/usr/bin/sandbox-exec", ["-p", selected, ...argv], {
        cwd: trial.workspace,
        env,
        timeout: 10000,
        maxBuffer: 32768,
      });
      observation.exitCode = 0;
      observation.stdout = result.stdout;
      observation.stderr = result.stderr;
    } catch (error) {
      const failure = error as {
        code?: number;
        signal?: string;
        stdout?: string;
        stderr?: string;
      };
      observation.exitCode = typeof failure.code === "number" ? failure.code : null;
      observation.signal = failure.signal ?? null;
      observation.stdout = failure.stdout ?? "";
      observation.stderr = failure.stderr ?? "";
    }
    for (const field of ["stdout", "stderr"] as const)
      observation[field] = sanitize(observation[field], [trial.root, outside.root, input.source]);
    probes.push(observation);
    return observation;
  };
  await run("baseline-allow-default-true", "(version 1)(allow default)", ["/usr/bin/true"]);
  await run(
    "legacy-deny-default-true",
    profile.replace(rootPermission, "").replace(sslPermission, ""),
    ["/usr/bin/true"],
  );
  await run("root-literal-true", profile.replace(sslPermission, ""), ["/usr/bin/true"]);
  let allowedHits = 0;
  let forbiddenHits = 0;
  const allowed = createServer((_request, response) => {
    allowedHits++;
    response.end("allowed");
  });
  const forbidden = createServer((_request, response) => {
    forbiddenHits++;
    response.end("forbidden");
  });
  let runtimeCanariesPassed = false;
  try {
    await new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => forbidden.listen(0, "127.0.0.1", resolve));
    const allowedUrl = `http://127.0.0.1:${(allowed.address() as AddressInfo).port}`;
    const forbiddenUrl = `http://127.0.0.1:${(forbidden.address() as AddressInfo).port}`;
    const networkProfile = nativeProfile({
      ...policy,
      ports: [(allowed.address() as AddressInfo).port],
    });
    const curl = [
      "/usr/bin/curl",
      "--disable",
      "--noproxy",
      "*",
      "-fsS",
      "--max-time",
      "2",
      allowedUrl,
    ];
    await run("curl-without-system-ssl-config", networkProfile.replace(sslPermission, ""), curl);
    const curlControl = await run("curl-positive-control", networkProfile, curl);
    await writeFile(path.join(outside.root, "sentinel"), "synthetic-outside");
    await writeFile(path.join(outside.root, "grader"), "synthetic-grader");
    await writeFile(path.join(trial.workspace, "input"), "synthetic-input");
    await symlink(outside.root, path.join(trial.workspace, "escape"));
    const script = [
      "import errno, json, os, pathlib, socket, subprocess, sys, urllib.request",
      "root, outside, allowed, forbidden = sys.argv[1:]",
      "checks = {}",
      "checks['read'] = pathlib.Path(root, 'input').read_text() == 'synthetic-input'",
      "pathlib.Path(root, 'write').write_text('synthetic-output')",
      "checks['write'] = pathlib.Path(root, 'write').read_text() == 'synthetic-output'",
      "def denied(file, mode):",
      "    try:",
      "        with open(file, mode) as stream:",
      "            stream.write('synthetic') if mode == 'w' else stream.read()",
      "        return False",
      "    except OSError as error:",
      "        return error.errno in (errno.EPERM, errno.EACCES)",
      "checks['outside-read'] = denied(os.path.join(outside, 'sentinel'), 'r')",
      "checks['outside-write'] = denied(os.path.join(outside, 'write'), 'w')",
      "checks['symlink'] = denied(os.path.join(root, 'escape', 'sentinel'), 'r')",
      "checks['grader'] = denied(os.path.join(outside, 'grader'), 'r')",
      "child = subprocess.run([sys.executable, '-I', '-S', '-c', \"import pathlib,sys; pathlib.Path(sys.argv[1]).read_text()\", os.path.join(outside, 'sentinel')], capture_output=True)",
      "checks['child'] = child.returncode == 1 and b'PermissionError' in child.stderr",
      "checks['allowed-egress'] = urllib.request.urlopen(allowed, timeout=2).read() == b'allowed'",
      "try:",
      "    urllib.request.urlopen(forbidden, timeout=2)",
      "    checks['forbidden-egress'] = False",
      "except OSError:",
      "    checks['forbidden-egress'] = True",
      "print(json.dumps(checks, sort_keys=True))",
      "sys.exit(0 if all(checks.values()) else 1)",
    ].join("\n");
    const runtime = await run("installed-python-isolated-stdlib", networkProfile, [
      interpreter,
      "-I",
      "-S",
      "-c",
      script,
      trial.workspace,
      outside.root,
      allowedUrl,
      forbiddenUrl,
    ]);
    runtimeCanariesPassed =
      containment.passed &&
      curlControl.exitCode === 0 &&
      runtime.exitCode === 0 &&
      allowedHits >= 2 &&
      forbiddenHits === 0;
    // These bounded probes test whether per-process rlimits can supply the missing
    // process-tree resource contract. They never allocate more than 64 MiB or 8 KiB disk.
    const resources = [
      "import json, pathlib, resource, sys",
      "result = {}",
      "limit = 16 * 1024 * 1024",
      "try:",
      "    resource.setrlimit(resource.RLIMIT_RSS, (limit, limit))",
      "    block = bytearray(64 * 1024 * 1024)",
      "    result['rss'] = {'requestedBytes': limit, 'allocatedBytes': len(block), 'peakBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}",
      "except (ValueError, OSError, MemoryError) as error:",
      "    result['rss'] = {'requestedBytes': limit, 'errorType': type(error).__name__, 'error': str(error)}",
      "resource.setrlimit(resource.RLIMIT_FSIZE, (4096, 4096))",
      "for name in ['disk-a', 'disk-b']:",
      "    pathlib.Path(sys.argv[1], name).write_bytes(b'x' * 4096)",
      "result['disk'] = {'perFileLimitBytes': 4096, 'aggregateBytes': sum(pathlib.Path(sys.argv[1], name).stat().st_size for name in ['disk-a', 'disk-b'])}",
      "print(json.dumps(result, sort_keys=True))",
    ].join("\n");
    await run("per-process-resource-limits", profile, [
      interpreter,
      "-I",
      "-S",
      "-c",
      resources,
      trial.workspace,
    ]);
  } finally {
    await new Promise<void>((resolve) => allowed.close(() => resolve()));
    await new Promise<void>((resolve) => forbidden.close(() => resolve()));
    await rm(path.join(trial.workspace, "escape"), { force: true });
  }
  return { containment, probes, interpreterHash, runtimeCanariesPassed };
}
