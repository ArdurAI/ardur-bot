import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gradeOutcome, unexpectedSymlinkPaths } from "../../scoreboard/graders/outcome.js";
import { contentDigest } from "../../scoreboard/manifest.js";
import { getTask } from "../../scoreboard/tasks/catalog.js";
import { referenceSolution } from "../../scoreboard/tasks/reference.js";
import { HermesContainerAdapter, WORKSPACE_NOT_INSPECTED } from "../adapters/hermes-container.js";
import type { VersusEvent } from "../adapters/types.js";
import { BudgetLedger, requireValue } from "../budget.js";
import { startGateway } from "../gateway.js";
import { createTrialDirectory, destroyOwnedDirectory } from "../isolation.js";
import { bytesHash, inspectBuild, sanitize } from "../provenance.js";
import { selfTestBudget } from "../self-test.js";
import { probeBudgetAdmission } from "./command-probe.js";
import { qualifyCancellation, qualifyOrdinaryExecution } from "./ordinary.js";
import {
  COMPUTER_IMAGE,
  HERMES_CONTAINER_REVISION,
  HERMES_IMAGE,
  HERMES_IMAGE_PAYLOAD_BYTES,
  HERMES_PULL,
} from "./policy.js";
import { assessAggregateDisk, qualifyHermesProduct } from "./product-roundtrip.js";
import { ContainerSession, inspectImage } from "./session.js";

export async function capture(session: ContainerSession, script: string) {
  const child = await session.exec(["/usr/bin/python3", "-I", "-S", "-u", "-c", script]);
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.length > 1048576) void session.destroy();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 1048576) void session.destroy();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr: sanitize(stderr) };
}
const STANDIN = String.raw`
import json, sys, urllib.request
args = sys.argv[1:]
assert args[0] == 'chat' and '--oneshot' in args and '--query-file' in args
assert '-z' not in args and '--base-url' not in args
config = json.load(open('/opt/data/state/config.yaml'))
def post(url, value):
    req = urllib.request.Request(url, data=json.dumps(value).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=10) as response: return json.load(response)
broker = config['mcp_servers']['mcp-scoreboard']['url']
post(broker, {'jsonrpc':'2.0','id':1,'method':'initialize','params':{}})
post(broker, {'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'read_file','arguments':{'path': config.get('fixture_input', 'brief.md')}}})
response = post(config['model']['base_url'] + '/chat/completions', {'model':config['model']['default'],'messages':[{'role':'user','content':open('/opt/data/state/query.txt').read()}]})
artifact = response['choices'][0]['message']['content']
result = post(broker, {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'write_file','arguments':{'path':'result.json','content':artifact}}})
assert not result['result'].get('isError'), result
print('╭─⚕ Hermes──╮\n  Saved the requested result.\n╰────────────╯')
`;

/** Cancel and loss probes fail a symlink the task did not declare, the same rule as a success grade. */
export function retainsReceiptsWithoutWorkspace(input: {
  cancelled: boolean;
  terminal: string;
  effects: readonly unknown[];
  files?: Record<string, string>;
  links?: readonly string[];
  expectedLinks?: readonly string[];
  snapshot?: { error?: string };
  providerRequests: number;
  gradedPassed: boolean;
}) {
  if (input.snapshot?.error || input.files === undefined || !Array.isArray(input.links))
    return false;
  return (
    input.terminal === (input.cancelled ? "cancelled" : "uncertain") &&
    input.effects.length === 1 &&
    Object.keys(input.files).length === 0 &&
    unexpectedSymlinkPaths(input.expectedLinks, input.links).length === 0 &&
    input.providerRequests === 0 &&
    !input.gradedPassed
  );
}

/** Explicit opt-in container probes; never pulls an image or invokes an inference endpoint. */
export async function qualifyContainers(output: string, standin: boolean) {
  await mkdir(output, { recursive: true });
  const target = path.join(output, "container-qualification.json");
  const build = await inspectBuild();
  const image = standin ? COMPUTER_IMAGE : HERMES_IMAGE;
  const report = {
    version: 1,
    tier: "T0",
    kind: "container-contract-qualification",
    build: build.build,
    image,
    imageDigest: null as string | null,
    runtimeRevision: null as string | null,
    cohort: standin ? "scripted-standin" : "hermes-release-linux-arm64",
    realModelCalls: 0,
    imagePulls: 0,
    packageDownloads: 0,
    status: "started",
    checks: [] as { name: string; passed: boolean; evidence: unknown }[],
    hermesAdapter: null as unknown,
    failures: [] as string[],
    requiredPull: HERMES_PULL,
    imagePayloadBytes: HERMES_IMAGE_PAYLOAD_BYTES,
    qualificationCoverage:
      "containment/resources and scripted adapter protocols; no model or product-quality qualification",
  };
  const save = () => writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(target, JSON.stringify(report), { flag: "wx" });
  let resource: Awaited<ReturnType<typeof createTrialDirectory>> | undefined;
  const sessions: ContainerSession[] = [];
  try {
    const identity = await inspectImage(image);
    report.imageDigest = identity.id;
    report.runtimeRevision = identity.revision;
    if (!standin)
      requireValue(
        identity.revision === HERMES_CONTAINER_REVISION,
        "Hermes release revision drift",
      );
    resource = await createTrialDirectory(tmpdir());
    const budget = selfTestBudget();
    budget.resources = {
      ...budget.resources,
      memoryBytes: 100663296,
      diskBytes: 8388608,
      processes: 24,
      cpuMs: 20000,
    };
    budget.perTrial.wallMs = 120000;
    const session = await ContainerSession.open({
      root: resource.state,
      image,
      budget,
      wallMs: 60000,
    });
    sessions.push(session);
    report.checks.push({
      name: "inspected-policy-and-cgroup-binding",
      passed: true,
      evidence: session.proof,
    });
    await session.write("workspace/input.txt", "synthetic-input");
    const outside = path.join(resource.root, "outside-canary");
    const grader = path.join(resource.root, "hidden-grader");
    await writeFile(outside, "synthetic-outside");
    await writeFile(grader, "synthetic-grader");
    const checks = await capture(
      session,
      `
import json, os, socket
out = {}
def denied(name, action):
    try: action(); out[name] = False
    except (OSError, RuntimeError): out[name] = True
out['non-root'] = os.getuid() == 65532
out['positive-read'] = open('/opt/data/workspace/input.txt').read() == 'synthetic-input'
with open('/opt/data/workspace/written.txt','w') as f: f.write('bounded')
out['positive-write'] = open('/opt/data/workspace/written.txt').read() == 'bounded'
denied('outside-read', lambda: open(${JSON.stringify(outside)}).read())
denied('outside-write', lambda: open('/etc/versus-outside-canary','w'))
denied('hidden-grader', lambda: open(${JSON.stringify(grader)}).read())
os.symlink(${JSON.stringify(outside)}, '/opt/data/workspace/escape')
denied('symlink-read', lambda: open('/opt/data/workspace/escape').read())
denied('symlink-write', lambda: open('/opt/data/workspace/escape','w'))
os.unlink('/opt/data/workspace/escape')
denied('unadmitted-child', os.fork)
denied('relay-control-fds-invisible', lambda: open('/proc/1/fd/0','rb'))
denied('relay-signal-denied', lambda: os.kill(1,0))
out['admitted-process-cgroup'] = open('/sys/fs/cgroup/pids.max').read().strip() == '24'
out['daemon-socket-invisible'] = not os.path.exists('/var/run/docker.sock')
out['pid-namespace'] = 'python3' in open('/proc/1/cmdline').read()
out['no-shared-memory-volume'] = not os.path.exists('/dev/shm')
for name, address in [('forbidden-egress',('203.0.113.1',80)),('host-gateway-denied',('192.0.2.1',80)),('other-loopback-port',('127.0.0.1',1))]:
    def connect(address=address):
        with socket.socket() as sock: sock.settimeout(.2); sock.connect(address)
    denied(name,connect)
def dns():
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock: sock.sendto(b'canary',('192.0.2.1',53))
denied('external-dns-denied',dns)
print(json.dumps(out))
`,
    );
    requireValue(checks.code === 0, `Containment probe failed: ${checks.stderr}`);
    for (const [name, passed] of Object.entries(JSON.parse(checks.stdout)))
      report.checks.push({
        name,
        passed: passed === true,
        evidence: "benign sentinel in inspected container",
      });
    const other = await ContainerSession.open({
      root: resource.state,
      image,
      budget,
      wallMs: 10000,
    });
    sessions.push(other);
    report.checks.push({
      name: "trial-state-separation",
      passed: !("written.txt" in (await other.snapshot())),
      evidence: other.proof,
    });
    await other.destroy();
    const admission = await probeBudgetAdmission(session, budget);
    report.checks.push({
      name: "tool-and-descendant-admission",
      passed: admission.passed,
      evidence: admission.evidence,
    });
    const cpu = await capture(
      session,
      `import time,json\nstart=time.monotonic(); cpu=time.process_time()\nwhile time.monotonic()-start<1.5: pass\nprint(json.dumps({'cpuSeconds':time.process_time()-cpu,'wallSeconds':time.monotonic()-start,'stat':open('/sys/fs/cgroup/cpu.stat').read()}))`,
    );
    const cpuResult = JSON.parse(cpu.stdout);
    report.checks.push({
      name: "cpu-quota-throttles",
      passed:
        cpu.code === 0 && cpuResult.cpuSeconds < 1 && /nr_throttled [1-9]/.test(cpuResult.stat),
      evidence: cpuResult,
    });
    const pids = await capture(
      session,
      `import threading,json\nend=threading.Event(); threads=[]; limited=False\ntry:\n for i in range(64):\n  t=threading.Thread(target=end.wait); t.start(); threads.append(t)\nexcept RuntimeError: limited=True\nprint(json.dumps({'limited':limited,'threads':len(threads),'events':open('/sys/fs/cgroup/pids.events').read()}))\nend.set()\nfor t in threads:t.join()`,
    );
    const pidResult = JSON.parse(pids.stdout);
    report.checks.push({
      name: "pids-limit-enforced",
      passed:
        pids.code === 0 &&
        pidResult.limited &&
        pidResult.threads < 24 &&
        /max [1-9]/.test(pidResult.events),
      evidence: pidResult,
    });
    const disk = await capture(
      session,
      `import json,os,errno\nmount=""\nfor line in open("/proc/mounts"):\n parts=line.split()\n if len(parts)>1 and parts[1]=="/opt/data": mount=line.strip()\na="/opt/data/first"; b="/opt/data/second"; denied=False\nwith open(a,"wb") as f: f.write(b"a"*(3*1024*1024))\ntry:\n with open(b,"wb") as f:\n  for i in range(96): f.write(b"b"*65536)\nexcept OSError as e: denied=e.errno==errno.ENOSPC\nsizes=[os.stat(a).st_size, os.stat(b).st_size]\nprint(json.dumps({"enospc":denied,"sizes":sizes,"aggregateBytes":sum(sizes),"mount":mount}))\nos.unlink(a); os.unlink(b)`,
    );
    const diskResult = JSON.parse(disk.stdout) as {
      enospc?: boolean;
      sizes?: number[];
      aggregateBytes?: number;
      mount?: string;
    };
    const alive = disk.code === 0 ? await capture(session, "print('container-alive')") : null;
    const diskAssessment = assessAggregateDisk({
      code: disk.code,
      probe: diskResult,
      capBytes: budget.resources.diskBytes,
      followUpCode: alive?.code ?? null,
    });
    report.checks.push({
      name: "aggregate-disk-cap",
      passed: diskAssessment.passed && alive?.stdout.trim() === "container-alive",
      evidence: diskAssessment.evidence,
    });
    const oom = await capture(session, "x=bytearray(256*1024*1024); print(len(x))");
    const memory = await capture(session, "print(open('/sys/fs/cgroup/memory.events').read())");
    report.checks.push({
      name: "memory-limit-kill",
      passed: oom.code === 137 && /oom_kill [1-9]/.test(memory.stdout),
      evidence: { exitCode: oom.code, events: memory.stdout },
    });
    await session.destroy();
    await save();
    if (standin) {
      const laneRoot = resource.state;
      const openLane = () =>
        ContainerSession.open({
          root: laneRoot,
          image,
          budget,
          wallMs: 60000,
        });
      const ordinary = await openLane();
      sessions.push(ordinary);
      report.checks.push(...(await qualifyOrdinaryExecution(ordinary)));
      const cancellation = await openLane();
      sessions.push(cancellation);
      report.checks.push(...(await qualifyCancellation(cancellation)));
      await save();
      const task = getTask("task-01");
      const fixture = referenceSolution(task);
      const directory = await createTrialDirectory(resource.state);
      const scriptedBudget = selfTestBudget();
      const ledger = new BudgetLedger(scriptedBudget);
      ledger.open("container-standin");
      const events: VersusEvent[] = [];
      const emit = (
        kind: VersusEvent["kind"],
        source: VersusEvent["source"],
        data: Record<string, unknown>,
      ) =>
        events.push({
          kind,
          source,
          data,
          trialId: "container-standin",
          at: events.length,
          sequence: events.length,
          clock: "virtual",
        });
      let upstream = 0;
      const gateway = await startGateway({
        budget: scriptedBudget,
        ledger,
        evidenceKind: "virtual",
        transport: async () => {
          upstream++;
          return Response.json({
            model: scriptedBudget.model.id,
            choices: [{ message: { role: "assistant", content: JSON.stringify(fixture.result) } }],
          });
        },
      });
      const adapter = new HermesContainerAdapter({
        ledger,
        standin: STANDIN.replace("'brief.md'", JSON.stringify(Object.keys(task.files)[0])),
        observedRoute: () => ({
          endpoint: scriptedBudget.endpoint.origin,
          model: scriptedBudget.model.id,
          digest: scriptedBudget.model.digest,
        }),
      });
      try {
        await adapter.prepare({
          id: "container-standin",
          pairId: "container-standin-pair",
          task,
          workspace: directory.workspace,
          stateDirectory: directory.state,
          budget: scriptedBudget,
          providerUrl: gateway.capability("container-standin", "main", emit),
          brokerUrl: "unused",
          revokeProvider: () => gateway.revoke("container-standin"),
          emit,
          signal: new AbortController().signal,
        });
        const positive = await capture(
          adapter.session!,
          "import urllib.request,json\nwith urllib.request.urlopen('http://127.0.0.1:18080/provider/models',timeout=5) as r:print(r.status)",
        );
        report.checks.push({
          name: "positive-gateway-relay",
          passed: positive.code === 0 && positive.stdout.trim() === "200",
          evidence: { code: positive.code },
        });
        await adapter.submit();
        const artifact = await adapter.collect();
        const grade = gradeOutcome(task, artifact.observation);
        requireValue(
          grade.passed && upstream === 1,
          `Scripted container adapter failed: ${artifact.outcomeReason}`,
        );
        report.hermesAdapter = {
          cohort: adapter.cohort,
          passed: true,
          grade,
          terminal: artifact.observation.terminal,
          reply: artifact.observation.reply,
          upstreamScriptedRequests: upstream,
          ledger: ledger.snapshot(),
          events,
          observationHash: contentDigest(artifact.observation),
        };
      } finally {
        await adapter.destroy();
        await gateway.close();
        await destroyOwnedDirectory(directory);
      }
      for (const cancelled of [false, true]) {
        const id = cancelled ? "container-cancel" : "container-loss";
        const trial = await createTrialDirectory(resource.state);
        const task = getTask("task-04");
        const ledger = new BudgetLedger(scriptedBudget);
        ledger.open(id);
        const emit = () => undefined;
        const gateway = await startGateway({
          budget: scriptedBudget,
          ledger,
          evidenceKind: "virtual",
          transport: async () => {
            throw new Error("Loss probe must not request a provider");
          },
        });
        const lost = new HermesContainerAdapter({
          ledger,
          standin: "raise RuntimeError('must not start')",
        });
        try {
          await lost.prepare({
            id,
            pairId: id,
            task,
            workspace: trial.workspace,
            stateDirectory: trial.state,
            budget: scriptedBudget,
            providerUrl: gateway.capability(id, "main", emit),
            brokerUrl: "unused",
            revokeProvider: () => gateway.revoke(id),
            emit,
            signal: new AbortController().signal,
          });
          const args = referenceSolution(task).updates[0]!;
          lost.broker!.decide(
            contentDigest({ trialId: id, name: "SCOREBOARD_UPDATE", args }),
            true,
          );
          await lost.broker!.call("SCOREBOARD_UPDATE", args);
          if (cancelled) await lost.cancel();
          else await lost.session!.destroy();
          await lost.submit();
          const retained = await lost.collect();
          const observed = retained.observation;
          const uninspected =
            observed.snapshot?.error !== undefined ||
            observed.files === undefined ||
            observed.links === undefined;
          const passed =
            !uninspected &&
            retainsReceiptsWithoutWorkspace({
              cancelled,
              terminal: observed.terminal,
              effects: observed.effects,
              files: observed.files,
              links: observed.links,
              expectedLinks: task.links,
              snapshot: observed.snapshot,
              providerRequests: gateway.requests.length,
              gradedPassed: gradeOutcome(task, observed).passed,
            });
          report.checks.push({
            name: `${id}-retains-receipts-and-nonsuccess`,
            passed,
            evidence: uninspected
              ? { failure: WORKSPACE_NOT_INSPECTED, ...retained, ledger: ledger.snapshot() }
              : { ...retained, ledger: ledger.snapshot() },
          });
        } finally {
          await lost.destroy();
          await gateway.close();
          await destroyOwnedDirectory(trial);
        }
      }
    } else if (report.checks.every((check) => check.passed)) {
      const product = await qualifyHermesProduct(resource.state);
      report.checks.push({
        name: "dependency-manifest",
        passed:
          product.dependencyManifest.missingBytes === 0 &&
          product.dependencyManifest.revisionMatchesImageLabel &&
          product.dependencyManifest.packageDownloads === 0,
        evidence: product.dependencyManifest,
      });
      report.checks.push({
        name: "product-tool-round-trip",
        passed: product.passed,
        evidence: product.roundTrip ?? { failure: product.failure },
      });
    }
    const productRoundTrip = report.checks.find(
      (check) => check.name === "product-tool-round-trip",
    );
    report.status = !report.checks.every((check) => check.passed)
      ? "failed"
      : standin
        ? "standin-qualified"
        : productRoundTrip?.passed
          ? "product-qualified"
          : "container-boundary-qualified-product-unqualified";
    if (report.status === "failed")
      report.failures.push(
        ...report.checks
          .filter((check) => !check.passed)
          .map((check) => {
            const failure = (check.evidence as { failure?: unknown }).failure;
            return typeof failure === "string" ? failure : check.name;
          }),
      );
  } catch (error) {
    report.status = "blocked";
    report.failures.push(sanitize(error instanceof Error ? error.message : String(error)));
  } finally {
    for (const session of sessions) await session.destroy();
    if (resource) await destroyOwnedDirectory(resource);
    await save();
  }
  await writeFile(
    path.join(output, "checksums.json"),
    JSON.stringify(
      [{ name: "container-qualification.json", sha256: bytesHash(await readFile(target)) }],
      null,
      2,
    ),
    { flag: "wx" },
  );
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help")
    console.log(
      "Use --stand-in --out <new-directory> or --hermes --out <new-directory>. No pulls, packages or model calls.",
    );
  else if (
    args.length === 3 &&
    ["--stand-in", "--hermes"].includes(args[0]!) &&
    args[1] === "--out"
  ) {
    qualifyContainers(path.resolve(args[2]!), args[0] === "--stand-in")
      .then((report) => {
        console.log(`${report.status}; real model calls: 0`);
        process.exitCode =
          report.status === "standin-qualified" || report.status === "product-qualified" ? 0 : 2;
      })
      .catch((error) => {
        console.error(sanitize(String(error)));
        process.exitCode = 2;
      });
  } else {
    console.error("Unsupported container qualification arguments");
    process.exitCode = 2;
  }
}
