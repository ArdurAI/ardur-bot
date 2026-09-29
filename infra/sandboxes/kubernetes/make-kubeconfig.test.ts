import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  kubernetesContexts,
  snapshotKubeconfig,
} from "../../../packages/adapters/src/kubernetes-client.js";

const script = path.join(import.meta.dirname, "make-kubeconfig.sh");
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.bG9uZy1saXZlZC1maXh0dXJl";
const BOUND = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJib3VuZCJ9.Ym91bmQtZml4dHVyZQ";
// A kubectl double: records every call and stdin, and answers from FAKE_* variables.
const KUBECTL = String.raw`#!/bin/sh
set -eu
count=$(wc -l < "$FAKE_KUBECTL_DIR/calls.log" 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s\n' "$*" >> "$FAKE_KUBECTL_DIR/calls.log"
case " $* " in *" -f - "*) cat > "$FAKE_KUBECTL_DIR/stdin-$count.yaml" ;; esac
case " $* " in
  *" version -o json "*)
    printf '{\n  "clientVersion": {\n    "gitVersion": "v1.33.1"\n  },\n  "serverVersion": {\n    "major": "1",\n    "minor": "31+",\n    "gitVersion": "%s"\n  }\n}\n' "$FAKE_SERVER_VERSION" ;;
  *" get namespace "*) [ -n "$FAKE_NAMESPACE_MISSING" ] || echo "namespace/present" ;;
  *" get secret "*) printf '%s' "$FAKE_TOKEN" | base64 | tr -d '\n' ;;
  *" create token "*) printf '%s\n' "$FAKE_BOUND_TOKEN" ;;
  *"cluster.server}"*) printf '%s' "$FAKE_SERVER" ;;
  *"cluster.certificate-authority-data}"*) printf '%s' "$FAKE_CA" ;;
  *"cluster.insecure-skip-tls-verify}"*) printf '%s' "$FAKE_SKIP_TLS" ;;
  *" get --raw /apis/metrics.k8s.io/v1beta1 "*)
    if [ -n "$FAKE_NO_METRICS" ]; then exit 1; else echo "metrics"; fi ;;
  *" auth can-i "*)
    case " $* " in
      *" nodes"* | *" -A "*) [ -n "$FAKE_CAPACITY" ] ;;
      *"$FAKE_DENY"*) exit 1 ;;
    esac ;;
  *" apply -f - "* | *" create -f - "*) echo "applied" ;;
  *) echo "unexpected kubectl call: $*" >&2; exit 2 ;;
esac
`;

let work = "";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function run(args: string[], env: Record<string, string> = {}, setup?: (dir: string) => void) {
  work = mkdtempSync(path.join(tmpdir(), "make-kubeconfig-"));
  directories.push(work);
  mkdirSync(path.join(work, "bin"));
  writeFileSync(path.join(work, "bin", "kubectl"), KUBECTL, { mode: 0o755 });
  setup?.(work);
  const result = spawnSync("bash", [script, ...args], {
    cwd: work,
    encoding: "utf8",
    env: {
      PATH: `${path.join(work, "bin")}${path.delimiter}${process.env.PATH}`,
      HOME: work,
      FAKE_KUBECTL_DIR: work,
      FAKE_SERVER_VERSION: "v1.31.4-eks-0a1b2c3",
      FAKE_SERVER: "https://api.cluster.example.test:443",
      FAKE_CA: "Q0EtREFUQQ==",
      FAKE_TOKEN: TOKEN,
      FAKE_BOUND_TOKEN: BOUND,
      FAKE_NAMESPACE_MISSING: "",
      FAKE_SKIP_TLS: "",
      FAKE_CAPACITY: "",
      FAKE_DENY: "no such check",
      FAKE_NO_METRICS: "",
      ...env,
    },
  });
  const log = path.join(work, "calls.log");
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  const stdin = (call: string) =>
    readFileSync(path.join(work, `stdin-${calls.indexOf(call) + 1}.yaml`), "utf8");
  const stdins = readdirSync(work)
    .filter((name) => name.startsWith("stdin-"))
    .sort((a, b) => Number.parseInt(a.slice(6), 10) - Number.parseInt(b.slice(6), 10))
    .map((name) => readFileSync(path.join(work, name), "utf8"));
  const printed = `${result.stdout}${result.stderr}`;
  return { ...result, calls, stdin, stdins, printed };
}

describe("make-kubeconfig.sh", () => {
  it("passes bash -n", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it("creates the account in a new restricted namespace and writes a token kubeconfig", async () => {
    const result = run(["--context", "admin", "--namespace", "computers", "--create-namespace"], {
      FAKE_NAMESPACE_MISSING: "1",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.slice(0, 6)).toEqual([
      "--context admin version -o json",
      "--context admin config view --minify --flatten --raw -o jsonpath={.clusters[0].cluster.server}",
      "--context admin config view --minify --flatten --raw -o jsonpath={.clusters[0].cluster.certificate-authority-data}",
      "--context admin config view --minify --flatten --raw -o jsonpath={.clusters[0].cluster.insecure-skip-tls-verify}",
      "--context admin get namespace computers --ignore-not-found -o name",
      "--context admin create -f -",
    ]);
    const [namespace, account, secret] = result.stdins;
    expect(namespace).toContain("name: computers");
    expect(namespace).toContain("pod-security.kubernetes.io/enforce: restricted");
    for (const kind of ["ServiceAccount", "Role", "RoleBinding"])
      expect(account).toContain(`kind: ${kind}`);
    expect(account?.match(/namespace: \S+/g)).toEqual(Array(4).fill("namespace: computers"));
    expect(secret).toContain("type: kubernetes.io/service-account-token");
    expect(secret).toContain("kubernetes.io/service-account.name: ardurbot-computers");
    expect(result.calls).toContain(
      "--context admin get secret ardurbot-computers-token -n computers -o jsonpath={.data.token}",
    );
    const file = path.join(work, "ardurbot-computers.kubeconfig");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const kubeconfig = readFileSync(file, "utf8");
    for (const line of [
      'server: "https://api.cluster.example.test:443"',
      "certificate-authority-data: Q0EtREFUQQ==",
      `token: ${TOKEN}`,
      "namespace: computers",
    ])
      expect(kubeconfig).toContain(line);
    // Ardur accepts the file as a pasted kubeconfig.
    expect(await kubernetesContexts({ inline: kubeconfig })).toEqual([
      { name: "ardurbot", local: false },
    ]);
    await expect(snapshotKubeconfig({ inline: kubeconfig })).resolves.toHaveProperty("inline");
    // Checks run as the new account through the new file, for every permission the provider needs.
    const checks = result.calls.filter((call) => call.includes("auth can-i"));
    expect(
      checks.every((call) => call.startsWith("--kubeconfig ardurbot-computers.kubeconfig")),
    ).toBe(true);
    expect(checks).toContain(
      "--kubeconfig ardurbot-computers.kubeconfig auth can-i --quiet create pods --subresource=exec -n computers",
    );
    expect(result.stdout).toContain("yes  create pods exec");
    expect(result.stdout).toContain(
      "no   list nodes (optional; without it capacity shows as unknown)",
    );
    expect(result.printed).not.toContain(TOKEN);
    expect(result.calls.join("\n")).not.toContain(TOKEN);
    // Loading the Kubernetes client library for the check above can take a while on a busy machine.
  }, 120_000);

  it("issues a bound token with --duration and creates no token Secret", () => {
    const result = run(["--duration", "720h", "--output", "cluster.kubeconfig"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("create token ardurbot-computers -n ardurbot --duration 720h");
    expect(result.calls.some((call) => call.includes("get secret"))).toBe(false);
    expect(result.stdins).toHaveLength(1);
    expect(readFileSync(path.join(work, "cluster.kubeconfig"), "utf8")).toContain(
      `token: ${BOUND}`,
    );
    expect(result.stdout).toContain("expires after 720h");
    expect(result.printed).not.toContain(BOUND);
  });

  it("prints the manifests and commands with --dry-run and changes nothing", () => {
    const result = run([
      "--dry-run",
      "--namespace",
      "computers",
      "--create-namespace",
      "--with-capacity",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([]);
    for (const text of [
      "pod-security.kubernetes.io/enforce: restricted",
      "kind: RoleBinding",
      "name: ardurbot-computers-capacity-computers",
      "type: kubernetes.io/service-account-token",
      "auth can-i create pods --subresource=exec -n computers",
      "auth can-i list pods -A",
    ])
      expect(result.stdout).toContain(text);
    expect(result.stdout).not.toContain("namespace: ardurbot");
    expect(existsSync(path.join(work, "ardurbot-computers.kubeconfig"))).toBe(false);
  });

  it("grants and requires capacity reads with --with-capacity", () => {
    const granted = run(["--with-capacity"], { FAKE_CAPACITY: "1" });
    expect(granted.status, granted.stderr).toBe(0);
    expect(granted.stdins[1]).toContain("name: ardurbot-computers-capacity-ardurbot");
    const noMetrics = run(["--with-capacity"], { FAKE_CAPACITY: "1", FAKE_NO_METRICS: "1" });
    expect(noMetrics.status, noMetrics.stderr).toBe(0);
    expect(noMetrics.stdout).toContain(
      "skip list nodes.metrics.k8s.io (metrics API not available)",
    );

    const refused = run(["--with-capacity"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Some permissions are missing");
  });

  it("fails when the account lacks a permission the provider needs", () => {
    const result = run([], { FAKE_DENY: "create pods --subresource=exec" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no   create pods exec");
    expect(result.stderr).toContain("Some permissions are missing");
  });

  it.each([
    [{ FAKE_SERVER_VERSION: "v1.30.9" }, "Kubernetes 1.31 or newer"],
    [{ FAKE_SERVER: "http://api.cluster.example.test" }, "must use HTTPS"],
    [{ FAKE_SKIP_TLS: "true" }, "verified HTTPS"],
    [{ FAKE_CA: "" }, "no embedded CA data"],
    [{ FAKE_NAMESPACE_MISSING: "1" }, "add --create-namespace"],
  ])("refuses %j before changing the cluster", (env, message) => {
    const result = run([], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.calls.some((call) => / (apply|create) /.test(` ${call} `))).toBe(false);
    expect(existsSync(path.join(work, "ardurbot-ardurbot.kubeconfig"))).toBe(false);
  });

  it("never overwrites an existing file and validates its options before calling kubectl", () => {
    const existing = run([], {}, (dir) =>
      writeFileSync(path.join(dir, "ardurbot-ardurbot.kubeconfig"), "keep"),
    );
    expect(existing.status).toBe(1);
    expect(existing.stderr).toContain("already exists");
    expect(readFileSync(path.join(work, "ardurbot-ardurbot.kubeconfig"), "utf8")).toBe("keep");
    expect(existing.calls).toEqual([]);
    for (const args of [["--namespace", "Not_A_Label"], ["--duration", "-1h"], ["--output"]]) {
      const invalid = run(args);
      expect(invalid.status, args.join(" ")).toBe(1);
      expect(invalid.calls).toEqual([]);
    }
  });
});
