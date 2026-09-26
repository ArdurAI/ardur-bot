import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { contentDigest } from "../scoreboard/manifest.js";
import {
  budgetTemplate,
  parseBudget,
  record,
  requireValue,
  validateModelMetadataLabel,
} from "./budget.js";
import {
  HERMES_CONTAINER_CHECKS,
  HERMES_CONTAINER_REVISION,
  HERMES_IMAGE,
  HERMES_MINIMUM_CONTEXT_TOKENS,
} from "./containers/policy.js";
import { inspectImage } from "./containers/session.js";
import { writeEvidence } from "./evidence.js";
import { createTrialDirectory, destroyOwnedDirectory, prepareEnvironment } from "./isolation.js";
import { diagnoseNativeIsolation } from "./native-diagnostics.js";
import { findExecutable, inspectBuild, inspectHermes, sanitize } from "./provenance.js";
import { planPairs } from "./scheduler.js";
import type { RouteExpectation } from "./serving.js";
import { ModelNotLoadedError, parseServingContext, readMetadata } from "./serving.js";

const exec = promisify(execFile);

/** An unloaded model is one sentence with its action; other metadata failures keep their detail. */
export function routeFailure(error: unknown) {
  return error instanceof ModelNotLoadedError
    ? error.message
    : sanitize(`Model metadata: ${String(error)}`);
}

/** Metadata only: no generation, pull, load, copy, create, delete, or keep-alive operation. */
export async function inspectLocalRoute(expected: RouteExpectation, transport = fetch) {
  const origin = new URL(expected.origin);
  requireValue(
    origin.origin === expected.origin &&
      origin.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(origin.hostname),
    "Qualification requires a numeric loopback origin",
  );
  requireValue(
    /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/.test(expected.model) &&
      /^(?!0{64})[a-f0-9]{64}$/.test(expected.digest),
    "Invalid expected model identity",
  );
  requireValue(
    Number.isSafeInteger(expected.contextSize) &&
      expected.contextSize > 2048 &&
      expected.contextSize <= 1_000_000,
    "Invalid shared context size",
  );
  const requests: { method: string; path: string }[] = [];
  const metadata = async (route: string, body?: unknown) => {
    requests.push({ method: body ? "POST" : "GET", path: route });
    return readMetadata(transport, expected.origin, route, body);
  };
  const matchTag = (value: Record<string, unknown>) => {
    requireValue(Array.isArray(value.models), "Missing model inventory");
    const matches = value.models.map(record).filter((item) => item.name === expected.model);
    requireValue(
      matches.length === 1 && matches[0]!.digest === expected.digest,
      "Model digest drift",
    );
    return matches[0]!;
  };
  const tag = matchTag(await metadata("/api/tags"));
  const serverVersion = (await metadata("/api/version")).version;
  validateModelMetadataLabel(serverVersion, "serverVersion");
  const show = await metadata("/api/show", { model: expected.model, verbose: true });
  const details = record(show.details);
  requireValue(details.quantization_level === expected.quantization, "Model quantization drift");
  const info = record(show.model_info);
  const architecture = String(info["general.architecture"] ?? "");
  const maximumContext = info[`${architecture}.context_length`];
  requireValue(
    typeof maximumContext === "number" && maximumContext >= expected.contextSize,
    "Shared context exceeds observed model architecture",
  );
  const tokenizer = Object.fromEntries(
    Object.entries(info).filter(([key]) => key.startsWith("tokenizer.")),
  );
  const tokens = tokenizer["tokenizer.ggml.tokens"];
  requireValue(Array.isArray(tokens) && tokens.length > 0, "Exact tokenizer metadata unavailable");
  requireValue(
    typeof show.template === "string" && show.template.length > 0,
    "Model template unavailable",
  );
  const effectiveContext = parseServingContext(await metadata("/api/ps"), expected);
  const model = {
    id: expected.model,
    digest: expected.digest,
    quantization: expected.quantization,
    serverVersion,
    tokenizerHash: contentDigest(tokenizer),
    templateHash: contentDigest(show.template),
  };
  // Detects a concurrent change during discovery only; a live gateway re-reads /api/ps at admission.
  matchTag(await metadata("/api/tags"));
  requireValue((await metadata("/api/version")).version === serverVersion, "Server version drift");
  const budget = parseBudget({
    ...budgetTemplate(),
    contextSize: expected.contextSize,
    endpoint: { origin: expected.origin, protocol: "ollama-openai", paid: false },
    model,
  });
  return {
    budget,
    requests,
    inventoryBytes: tag.size ?? null,
    maximumContext,
    capabilities: Array.isArray(show.capabilities)
      ? show.capabilities.filter((item) => typeof item === "string" && /^[a-z-]+$/.test(item))
      : [],
    toolRoundTrip: "not-run",
    effectiveContext,
    generationRequests: 0,
    settingsQualification:
      "Planning-time /api/ps observation; a live gateway re-reads it before each trial and model request",
  };
}

const HELP = `Non-generating versus qualification preflight

pnpm --filter @ardurbot/testkit exec tsx src/versus/qualification.ts --expected-hermes-revision <40-hex> --endpoint http://127.0.0.1:11434 --model llama3.1:8b --model-digest <64-hex> --quantization Q4_K_M --context-size 65536 --out ./artifacts/versus/qualification

Container cohort planning uses the same metadata checks and writes canary-budget.json.
It does not start a product, a container, or inference. Approval is never implied:

pnpm --filter @ardurbot/testkit exec tsx src/versus/qualification.ts --expected-hermes-revision 29112bef099274229cadff79cdff7bf7b99c4b77 --endpoint http://127.0.0.1:11434 --model llama3.1:8b --model-digest <64-hex> --quantization Q4_K_M --context-size 65536 --lane container --container-cohort-approval approved --container-report <container-qualification.json> --out ./artifacts/versus/container-cohort

Optional: --hermes-executable <path> --hermes-source <path>
Runs benign OS/interpreter probes and reads local model/Docker metadata only.
Never starts either product, a container, or inference. Failed qualification exits 2.
`;
export function parseQualificationArguments(args: string[]) {
  if (!args.length || (args.length === 1 && args[0] === "--help")) return null;
  const allowed = [
    "--expected-hermes-revision",
    "--endpoint",
    "--model",
    "--model-digest",
    "--quantization",
    "--context-size",
    "--out",
    "--hermes-executable",
    "--hermes-source",
    "--lane",
    "--container-cohort-approval",
    "--container-report",
  ];
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    requireValue(
      allowed.includes(key) && !(key in options) && value && !value.startsWith("--"),
      "Unknown, repeated or missing qualification option",
    );
    options[key] = value;
  }
  requireValue(
    allowed.slice(0, 7).every((key) => options[key]),
    "Explicit qualification identity and output required",
  );
  if (options["--lane"])
    requireValue(options["--lane"] === "container", "Unknown qualification lane");
  if (options["--container-cohort-approval"])
    requireValue(
      options["--container-cohort-approval"] === "approved",
      "Container cohort approval must be the explicit value approved",
    );
  requireValue(
    options["--lane"] === "container" ||
      (!options["--container-cohort-approval"] && !options["--container-report"]),
    "Container cohort flags require --lane container",
  );
  requireValue(
    /^[a-f0-9]{40}$/.test(options["--expected-hermes-revision"]!),
    "Expected revision requires forty hex characters",
  );
  return options;
}

function reportChecks(report: Record<string, unknown> | null) {
  const checks = report?.checks;
  return Array.isArray(checks)
    ? checks.map((item) => (item && typeof item === "object" ? record(item) : {}))
    : [];
}
function gate(report: Record<string, unknown> | null, name: string) {
  return reportChecks(report).find((item) => item.name === name) ?? null;
}
function counterSatisfied(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const counter = value as {
    nextRefused?: boolean;
    admitted?: number;
    cap?: number;
    effectAfterRefusal?: boolean;
  };
  return (
    counter.nextRefused === true &&
    counter.effectAfterRefusal === false &&
    typeof counter.cap === "number" &&
    counter.admitted === counter.cap
  );
}
/** Planning decision only. It does not start a container or a model request. */
export function assessContainerCohort(input: {
  approval: string | undefined;
  report: Record<string, unknown> | null;
  pinnedImage: { id: string; revision: string | null } | null;
  /** Every failure recorded before planning; any one of them blocks the cohort. */
  preflightFailures: readonly string[];
  routeContext: number | null;
  architectureMaximum: number | null;
  servingContext: number | null;
}) {
  const failures: string[] = [];
  const checks = reportChecks(input.report);
  const unqualifiedChecks = [
    ...HERMES_CONTAINER_CHECKS.filter((name) => gate(input.report, name)?.passed !== true),
    ...checks
      .filter((check) => check.passed !== true)
      .map((check) => (typeof check.name === "string" ? check.name : "unnamed-check")),
  ];
  const disk = gate(input.report, "aggregate-disk-cap");
  const diskEvidence =
    disk?.evidence && typeof disk.evidence === "object" ? record(disk.evidence) : null;
  const admission = gate(input.report, "tool-and-descendant-admission");
  const admissionEvidence =
    admission?.evidence && typeof admission.evidence === "object"
      ? record(admission.evidence)
      : null;
  const descendants =
    admissionEvidence?.descendants && typeof admissionEvidence.descendants === "object"
      ? record(admissionEvidence.descendants)
      : null;
  const product = gate(input.report, "product-tool-round-trip");
  const manifest = gate(input.report, "dependency-manifest");
  const manifestEvidence =
    manifest?.evidence && typeof manifest.evidence === "object" ? record(manifest.evidence) : null;
  const reportForPinnedImage =
    input.pinnedImage !== null &&
    input.pinnedImage.revision === HERMES_CONTAINER_REVISION &&
    input.report?.image === HERMES_IMAGE &&
    input.report.imageDigest === input.pinnedImage.id &&
    input.report.runtimeRevision === HERMES_CONTAINER_REVISION;
  const gates = {
    approval: input.approval === "approved",
    pinnedImage: reportForPinnedImage && input.report?.status === "product-qualified",
    containmentAndResources: unqualifiedChecks.length === 0,
    aggregateDisk:
      disk?.passed === true &&
      diskEvidence?.mechanism === "tmpfs-size" &&
      typeof diskEvidence.capBytes === "number" &&
      diskEvidence.containerAlive === true,
    toolAndDescendantAdmission:
      admission?.passed === true &&
      counterSatisfied(admissionEvidence?.toolCalls) &&
      counterSatisfied(descendants?.helpers) &&
      counterSatisfied(descendants?.commands),
    productToolRoundTrip:
      product?.passed === true &&
      input.report?.realModelCalls === 0 &&
      input.report?.imagePulls === 0 &&
      input.report?.packageDownloads === 0,
    dependencyManifest:
      manifest?.passed === true &&
      manifestEvidence?.missingBytes === 0 &&
      Array.isArray(manifestEvidence?.missingPackages) &&
      manifestEvidence.missingPackages.length === 0,
    contextPin:
      input.routeContext !== null &&
      input.architectureMaximum !== null &&
      input.servingContext !== null &&
      input.routeContext >= HERMES_MINIMUM_CONTEXT_TOKENS &&
      input.routeContext <= input.architectureMaximum &&
      input.servingContext === input.routeContext,
  };
  if (!gates.approval) failures.push("Container cohort approval is absent");
  if (!input.report) failures.push("Container qualification report is absent");
  if (!input.pinnedImage) failures.push("The pinned Hermes image was not inspected");
  else if (input.report && !reportForPinnedImage)
    failures.push("The container report is not for the inspected pinned Hermes image and revision");
  else if (input.report && !gates.pinnedImage)
    failures.push(
      `The container report for the pinned Hermes image is ${String(input.report.status)}; re-run container qualification until it is product-qualified`,
    );
  if (input.report && !gates.containmentAndResources)
    failures.push(
      `Container checks failed or missing: ${[...new Set(unqualifiedChecks)].join(", ")}`,
    );
  if (!gates.aggregateDisk) failures.push("Aggregate disk cap is not qualified");
  if (!gates.toolAndDescendantAdmission)
    failures.push("Tool and descendant budget admission is not qualified");
  if (!gates.productToolRoundTrip) failures.push("Hermes product tool round trip is not qualified");
  if (!gates.dependencyManifest) failures.push("Hermes dependency manifest is incomplete");
  if (input.routeContext === null || input.routeContext < HERMES_MINIMUM_CONTEXT_TOKENS)
    failures.push(
      `Hermes refuses a declared context below ${HERMES_MINIMUM_CONTEXT_TOKENS}; the approved shared context is ${input.routeContext ?? "unobserved"}`,
    );
  if (
    input.architectureMaximum === null ||
    input.architectureMaximum < HERMES_MINIMUM_CONTEXT_TOKENS
  )
    failures.push(
      `Observed model architecture maximum ${input.architectureMaximum ?? "unobserved"} is below the Hermes minimum ${HERMES_MINIMUM_CONTEXT_TOKENS}`,
    );
  if (
    input.routeContext !== null &&
    input.architectureMaximum !== null &&
    input.routeContext > input.architectureMaximum
  )
    failures.push(
      `Declared context ${input.routeContext} exceeds model architecture maximum ${input.architectureMaximum}`,
    );
  if (input.servingContext === null)
    failures.push("Local serving state does not attest the active context");
  else if (input.servingContext !== input.routeContext)
    failures.push(
      `Loaded serving context ${input.servingContext} does not match declared context ${input.routeContext ?? "unobserved"}`,
    );
  return {
    ready: failures.length === 0 && input.preflightFailures.length === 0,
    failures,
    gates,
  };
}

export async function runQualification(args: string[]) {
  const options = parseQualificationArguments(args);
  if (!options) {
    console.log(HELP);
    return 0;
  }
  const out = path.resolve(options["--out"]!);
  await mkdir(out, { recursive: true, mode: 0o700 });
  requireValue((await readdir(out)).length === 0, "Evidence output must be empty");
  const hermes = await inspectHermes({
    executable: options["--hermes-executable"],
    source: options["--hermes-source"],
    expectedRevision: options["--expected-hermes-revision"],
  });
  const containerLane = options["--lane"] === "container";
  if (!containerLane)
    requireValue(
      hermes.identity.revisionMatches && hermes.executable && hermes.source,
      "Installed Hermes revision mismatch or source unavailable; no probe started",
    );
  else
    requireValue(
      options["--expected-hermes-revision"] === HERMES_CONTAINER_REVISION,
      "Container cohort requires the pinned Linux Hermes revision",
    );
  const build = await inspectBuild();
  const trial = await createTrialDirectory(tmpdir());
  const outside = await createTrialDirectory(tmpdir());
  const failures: string[] = [];
  let native: Awaited<ReturnType<typeof diagnoseNativeIsolation>> | null = null;
  let route: Awaited<ReturnType<typeof inspectLocalRoute>> | null = null;
  let computer: {
    imageId: string;
    imageBytes: number;
    architecture: string;
    downloadBytes: 0;
  } | null = null;
  try {
    try {
      if (
        !(containerLane && !hermes.identity.revisionMatches) &&
        hermes.executable &&
        hermes.source
      )
        native = await diagnoseNativeIsolation({
          trial,
          outside,
          source: hermes.source,
          executable: hermes.executable,
        });
    } catch (error) {
      failures.push(
        sanitize(`Native diagnostics: ${String(error)}`, [
          trial.root,
          outside.root,
          hermes.source ?? "",
        ]),
      );
    }
    try {
      route = await inspectLocalRoute({
        origin: options["--endpoint"]!,
        model: options["--model"]!,
        digest: options["--model-digest"]!,
        quantization: options["--quantization"]!,
        contextSize: Number(options["--context-size"]),
      });
    } catch (error) {
      failures.push(routeFailure(error));
    }
    try {
      const docker = await findExecutable("docker");
      requireValue(docker, "Local Docker executable unavailable");
      const endpoint = (
        await exec(
          docker,
          ["context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}'],
          { timeout: 5000, maxBuffer: 8192 },
        )
      ).stdout.trim();
      requireValue(
        endpoint.startsWith("unix:///"),
        "Only a local Unix Docker engine may be inspected",
      );
      const env = await prepareEnvironment(trial.state, docker);
      const result = await exec(
        docker,
        [
          "--host",
          endpoint,
          "image",
          "inspect",
          "ardurbot/computer:local",
          "--format",
          "{{json .Id}} {{.Size}} {{json .Architecture}}",
        ],
        { env, timeout: 5000, maxBuffer: 8192 },
      );
      const [imageId, imageBytes, architecture] = JSON.parse(
        `[${result.stdout.trim().split(" ").join(",")}]`,
      ) as [string, number, string];
      requireValue(
        /^sha256:[a-f0-9]{64}$/.test(imageId) && Number.isSafeInteger(imageBytes) && imageBytes > 0,
        "Invalid local image metadata",
      );
      computer = { imageId, imageBytes, architecture, downloadBytes: 0 };
    } catch {
      failures.push("Cached local computer image unavailable; no pull or engine startup attempted");
    }
  } finally {
    await destroyOwnedDirectory(outside);
    await destroyOwnedDirectory(trial);
  }
  let containerCohort: Record<string, unknown> | null = null;
  if (containerLane) {
    let pinnedImage: { id: string; revision: string | null } | null = null;
    try {
      const image = await inspectImage(HERMES_IMAGE);
      requireValue(image.revision === HERMES_CONTAINER_REVISION, "Hermes image revision drift");
      pinnedImage = image;
    } catch (error) {
      failures.push(sanitize(String(error)));
    }
    let containerReport: Record<string, unknown> | null = null;
    if (options["--container-report"]) {
      try {
        const text = await readFile(options["--container-report"], "utf8");
        requireValue(text.length <= 8 * 1024 * 1024, "Container report exceeds byte cap");
        containerReport = record(JSON.parse(text));
      } catch (error) {
        failures.push(sanitize(`Container report: ${String(error)}`));
      }
    }
    const assessment = assessContainerCohort({
      approval: options["--container-cohort-approval"],
      report: containerReport,
      pinnedImage,
      preflightFailures: [...failures],
      routeContext: route?.budget.contextSize ?? null,
      architectureMaximum: typeof route?.maximumContext === "number" ? route.maximumContext : null,
      servingContext: typeof route?.effectiveContext === "number" ? route.effectiveContext : null,
    });
    failures.push(...assessment.failures);
    containerCohort = {
      lane: "separately-labeled-Linux-container-cohort",
      approval: options["--container-cohort-approval"] === "approved" ? "approved" : "absent",
      image: HERMES_IMAGE,
      imageDigest: pinnedImage?.id ?? null,
      sourceRevision: HERMES_CONTAINER_REVISION,
      nativeInterpreter: hermes.identity.revisionMatches
        ? "matches-pinned-revision"
        : "different-cohort",
      gates: assessment.gates,
      ready: assessment.ready,
    };
  } else
    failures.push(
      "Native hard process-tree CPU/RAM/pids and aggregate disk enforcement is unqualified; a sampling watchdog cannot issue a product launch proof",
      "This preflight does not run the container lane. Container disk, admission and the scripted Hermes tool round trip are reported only by the container qualification command.",
      "The shared-model tool round trip and the effective context remain unqualified; metadata is not inference qualification",
    );
  const ready = containerCohort?.ready === true;
  const qualification = {
    version: 1,
    status: ready ? "planned" : "blocked",
    productLaunches: 0,
    modelCalls: 0,
    canaryRuns: 0,
    native,
    route,
    computer,
    ...(containerCohort ? { containerCohort } : {}),
    failures,
    ardur: {
      ordinaryRpc: "see-separate-T0-RPC-self-test",
      liveBackend: "not-qualified",
      sourceSeams: [
        "infra/sandboxes/supervisor/src/computer-spec.ts",
        "packages/testkit/src/versus/adapters/ardur.ts",
      ],
    },
    alternative: {
      lane: "separately-labeled-Linux-container-cohort",
      imageDownloadBytes: computer ? 0 : null,
      required: [
        "Explicit cohort approval; the installed macOS Hermes interpreter cannot become a Linux install",
        "A pinned Linux Hermes runtime and dependency manifest with exact missing-package byte counts before any package download",
        "Read-only root plus bounded tmpfs/quota volumes, cgroup process-tree ceilings, no daemon socket or owner mounts",
        "Private gateway/broker network with default-deny egress and full tool/descendant admission",
      ],
    },
    cleanup: { ownedDirectoriesDestroyed: true, containersCreated: 0, ownerStateRead: false },
  };
  await writeEvidence(out, {
    mode: "qualification",
    build,
    hermes: hermes.identity,
    plan: planPairs(
      route?.budget.cohort ?? {
        tasks: ["task-01", "task-04"],
        repetitions: 1,
        history: "short",
        cacheState: "not-measured",
      },
    ),
    budget: route?.budget ?? null,
    trials: [],
    results: [],
    prerequisites: failures,
    launchPlan: {
      startsProducts: false,
      requestedAction: "non-generating-qualification",
      qualification,
    },
    isolation: native,
    protocolResults: qualification,
  });
  console.log(
    `Qualification retained; product launches: 0; model calls: 0; canary ${ready ? "planned" : "blocked"}.`,
  );
  return ready ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  runQualification(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(sanitize(String(error)));
      process.exitCode = 2;
    });
