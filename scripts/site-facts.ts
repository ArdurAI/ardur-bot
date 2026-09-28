import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GITHUB_MATCHING_ROUTINES_LIMIT,
  ROUTINE_HISTORY_LIMIT,
  WEBHOOK_MATCHING_ROUTINES_LIMIT,
  WEBHOOK_MAX_BODY_BYTES,
} from "../apps/api/src/limits.ts";
import { DOCUMENT_STORE_KINDS } from "../packages/adapters/src/memory/document-store-factory.ts";
import { GIT_PUBLISH_MODES } from "../packages/adapters/src/memory/git-store.ts";
import { listPiCatalog } from "../packages/adapters/src/pi-models.ts";
import {
  MIN_ONE_SHOT_LEAD_SECONDS,
  MIN_REPEATING_INTERVAL_SECONDS,
} from "../packages/adapters/src/schedule-tools.ts";
import { ComputerConnectionSettingsSchema } from "../packages/contracts/src/computer-connections.ts";
import {
  CreateRoutineInput,
  RoutineSchema,
  SpaceMemoryConfigSchema,
} from "../packages/contracts/src/domain.ts";
import { type SiteProduct, SiteProductSchema } from "../packages/contracts/src/site-product.ts";
import { POPULAR_MODEL_PROVIDER_IDS } from "../packages/core/src/model-providers.ts";
import { loadValidatedFeatureDocs, publishedDocumentation } from "./feature-docs";

type Provider = SiteProduct["providers"][number];
type ProviderMetadata = Pick<Provider, "name" | "access" | "status" | "accountHint">;

// Every shipped catalog ID must be described here. Do not infer access from an OAuth flag:
// the catalog also contains key-only and compatibility paths for subscription vendors.
export const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  "amazon-bedrock": { name: "Amazon Bedrock", access: "api-key", status: "available" },
  "ant-ling": { name: "Ant Ling", access: "api-key", status: "available" },
  anthropic: { name: "Anthropic", access: "api-key", status: "available", accountHint: "API key" },
  "azure-openai-responses": { name: "Azure OpenAI", access: "api-key", status: "available" },
  baseten: { name: "Baseten", access: "api-key", status: "available" },
  cerebras: { name: "Cerebras", access: "api-key", status: "available" },
  "cloudflare-ai-gateway": {
    name: "Cloudflare AI Gateway",
    access: "gateway",
    status: "available",
  },
  "cloudflare-workers-ai": {
    name: "Cloudflare Workers AI",
    access: "api-key",
    status: "available",
  },
  deepseek: { name: "DeepSeek", access: "api-key", status: "available" },
  fireworks: { name: "Fireworks", access: "api-key", status: "available" },
  "github-copilot": {
    name: "GitHub Copilot",
    access: "subscription",
    status: "available",
    accountHint: "Copilot account",
  },
  google: { name: "Google", access: "api-key", status: "available" },
  "google-vertex": { name: "Google Vertex AI", access: "api-key", status: "available" },
  groq: { name: "Groq", access: "api-key", status: "available" },
  huggingface: { name: "Hugging Face", access: "api-key", status: "available" },
  "kimi-coding": { name: "Kimi for Coding", access: "api-key", status: "available" },
  meta: { name: "Meta", access: "api-key", status: "available" },
  minimax: { name: "MiniMax", access: "api-key", status: "available" },
  "minimax-cn": { name: "MiniMax CN", access: "api-key", status: "available" },
  mistral: { name: "Mistral", access: "api-key", status: "available" },
  moonshotai: { name: "Moonshot AI", access: "api-key", status: "available" },
  "moonshotai-cn": { name: "Moonshot AI CN", access: "api-key", status: "available" },
  nvidia: { name: "NVIDIA", access: "api-key", status: "available" },
  openai: { name: "OpenAI", access: "api-key", status: "available" },
  "openai-codex": {
    name: "OpenAI Codex",
    access: "subscription",
    status: "available",
    accountHint: "ChatGPT account",
  },
  "openai-compatible": { name: "OpenAI-compatible server", access: "gateway", status: "available" },
  opencode: { name: "OpenCode Zen", access: "api-key", status: "available" },
  "opencode-go": { name: "OpenCode Go", access: "api-key", status: "available" },
  openrouter: { name: "OpenRouter", access: "api-key", status: "available" },
  "qwen-token-plan": { name: "Qwen Token Plan", access: "api-key", status: "available" },
  "qwen-token-plan-cn": { name: "Qwen Token Plan CN", access: "api-key", status: "available" },
  "qwen-token-plan-individual": {
    name: "Qwen Token Plan Individual",
    access: "api-key",
    status: "available",
  },
  radius: { name: "Radius", access: "api-key", status: "available" },
  together: { name: "Together", access: "api-key", status: "available" },
  "vercel-ai-gateway": { name: "Vercel AI Gateway", access: "gateway", status: "available" },
  xai: {
    name: "xAI",
    access: "subscription",
    status: "available",
    accountHint: "SuperGrok or X Premium account",
  },
  xiaomi: { name: "Xiaomi", access: "api-key", status: "available" },
  "xiaomi-token-plan-ams": {
    name: "Xiaomi Token Plan AMS",
    access: "api-key",
    status: "available",
  },
  "xiaomi-token-plan-cn": { name: "Xiaomi Token Plan CN", access: "api-key", status: "available" },
  "xiaomi-token-plan-sgp": {
    name: "Xiaomi Token Plan SGP",
    access: "api-key",
    status: "available",
  },
  zai: { name: "Z.AI", access: "api-key", status: "available" },
  "zai-coding-cn": { name: "Z.AI Coding CN", access: "api-key", status: "available" },
  // These are documented plans, but are not selectable catalog providers yet.
  "claude-cli": {
    name: "Claude Pro/Max through the CLI",
    access: "subscription",
    status: "roadmap",
    accountHint: "Claude account through your own CLI",
  },
  ollama: { name: "Ollama as a first-class choice", access: "local", status: "roadmap" },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productPath = "site/data/product.json";
const readmePath = "README.md";
const screenshotSpec = "apps/web/e2e/site-screenshots.spec.ts";
const generatedComment =
  "<!-- Generated from site/data/product.json by pnpm site:facts; edit that file. -->";
const triggerDetails: Record<string, { id: string; name: string; detail: string }> = {
  crons: {
    id: "schedule",
    name: "Schedule",
    detail: "Run at a chosen time or repeating schedule.",
  },
  webhookEnabled: {
    id: "webhook",
    name: "Webhook",
    detail: "Run when a configured webhook fires.",
  },
  githubEnabled: {
    id: "github",
    name: "GitHub",
    detail: "Run when a configured GitHub event arrives.",
  },
  messageProvider: {
    id: "message",
    name: "Message",
    detail: "Run when a connected message provider receives a message.",
  },
};
const nonTriggerInputKeys = new Set(["botId", "name", "prompt", "timezone", "notify", "active"]);

const MEMORY_DENIED_PHRASES = [
  "every memory",
  "instant sync",
  "works with any repo",
  "edits in every app automatically sync",
  "secrets can never leak",
  "tamper-proof",
  "private folders inside a shared repo",
  "all your skills and plugins travel with memory",
] as const;

export function memoryFromCode(): Pick<
  NonNullable<SiteProduct["memory"]>,
  "storage" | "publishModes"
> {
  const storeCopy = {
    postgres: {
      id: "database",
      name: "Built-in database",
      detail: "Keeps documents in Ardur's built-in database.",
      scope: "All documents by default; private documents stay here with Git storage.",
    },
    git: {
      id: "git",
      name: "Git repository",
      detail: "Keeps shared notes and their revision history in a connected repository.",
      scope: "Space-shared documents and their revision history.",
    },
    obsidian: {
      id: "obsidian",
      name: "Local memory folder",
      detail: "Keeps selected documents as files in a dedicated folder.",
      scope: "Space-shared documents and the connected owner's documents.",
    },
  } satisfies Record<
    (typeof DOCUMENT_STORE_KINDS)[number],
    NonNullable<SiteProduct["memory"]>["storage"][number]
  >;
  const modes = {
    publish: { id: "direct", name: "Publish directly" },
    propose: { id: "proposal", name: "Propose on a branch" },
  } satisfies Record<
    (typeof GIT_PUBLISH_MODES)[number],
    NonNullable<SiteProduct["memory"]>["publishModes"][number]
  >;
  const selectable = SpaceMemoryConfigSchema.shape.documentStore.unwrap().options;
  if (
    DOCUMENT_STORE_KINDS.length !== selectable.length ||
    DOCUMENT_STORE_KINDS.some((kind) => !selectable.includes(kind))
  )
    throw new Error("Document store kinds differ from the memory settings contract.");
  return {
    storage: DOCUMENT_STORE_KINDS.map((kind) => storeCopy[kind]),
    publishModes: GIT_PUBLISH_MODES.map((mode) => modes[mode]),
  };
}

export function routinesFromCode(): NonNullable<SiteProduct["routines"]> {
  const keys = Object.keys(CreateRoutineInput.shape).filter((key) => !nonTriggerInputKeys.has(key));
  for (const key of keys) {
    if (!(key in RoutineSchema.shape) || !triggerDetails[key]) {
      throw new Error(
        `Add routine trigger field "${key}" to triggerDetails in scripts/site-facts.ts.`,
      );
    }
  }
  return {
    triggers: keys.map((key) => triggerDetails[key]),
    minimumIntervalSeconds: MIN_REPEATING_INTERVAL_SECONDS,
    limits: [
      {
        id: "one-shot-future",
        text: "One-shot runs must be scheduled in the future.",
        value: MIN_ONE_SHOT_LEAD_SECONDS,
      },
      {
        id: "run-history",
        text: `Run history lists up to ${ROUTINE_HISTORY_LIMIT} of a routine's latest runs.`,
        value: ROUTINE_HISTORY_LIMIT,
      },
      {
        id: "webhook-body-bytes",
        text: `Webhook and GitHub event bodies are limited to ${WEBHOOK_MAX_BODY_BYTES / 1024} KB.`,
        value: WEBHOOK_MAX_BODY_BYTES,
      },
      {
        id: "github-matching-routines",
        text: `A GitHub event includes up to ${GITHUB_MATCHING_ROUTINES_LIMIT} of the most recently updated active routines that match it.`,
        value: GITHUB_MATCHING_ROUTINES_LIMIT,
      },
      {
        id: "webhook-matching-routines",
        text: `A webhook request includes up to ${WEBHOOK_MATCHING_ROUTINES_LIMIT} of the most recently updated active routines that match it.`,
        value: WEBHOOK_MATCHING_ROUTINES_LIMIT,
      },
    ],
  };
}

export function providersFromCatalog(catalog = listPiCatalog()): Provider[] {
  const shipped = [...new Set(catalog.map((entry) => entry.provider))];
  for (const id of shipped) {
    if (!PROVIDER_METADATA[id]) {
      throw new Error(`Add "${id}" to PROVIDER_METADATA in scripts/site-facts.ts.`);
    }
    if (PROVIDER_METADATA[id].status !== "available") {
      throw new Error(
        `Provider "${id}" ships in the catalog; set its PROVIDER_METADATA status to available.`,
      );
    }
  }
  for (const id of POPULAR_MODEL_PROVIDER_IDS) {
    if (!shipped.includes(id))
      throw new Error(`Featured provider "${id}" is missing from the model catalog.`);
  }
  return (
    Object.entries(PROVIDER_METADATA)
      .filter(([id, metadata]) => shipped.includes(id) || metadata.status === "roadmap")
      .map(([id, metadata]) => ({
        id,
        ...metadata,
        featured: POPULAR_MODEL_PROVIDER_IDS.some((popular) => popular === id),
      }))
      // Featured providers first, in the order the app's model picker shows them.
      .sort((a, b) => pickerRank(a.id) - pickerRank(b.id) || a.name.localeCompare(b.name))
  );
}

function pickerRank(id: string): number {
  const rank = (POPULAR_MODEL_PROVIDER_IDS as readonly string[]).indexOf(id);
  return rank === -1 ? POPULAR_MODEL_PROVIDER_IDS.length : rank;
}

export function computersFromRegistry(): SiteProduct["computers"] {
  const names: Record<string, string> = {
    docker: "Docker",
    podman: "Podman",
    kubernetes: "Kubernetes",
    ssh: "SSH machine",
  };
  const engines = ComputerConnectionSettingsSchema.shape.engine.options;
  for (const id of engines) {
    if (!names[id]) throw new Error(`Add "${id}" to computer names in scripts/site-facts.ts.`);
  }
  // The managed runtimes are cases in sandbox-factory.ts, not a public registry.
  return [
    { id: "local", name: "This computer" },
    ...engines.map((id) => ({ id, name: names[id] })),
    { id: "e2b", name: "E2B" },
    { id: "daytona", name: "Daytona" },
    { id: "box", name: "Box" },
  ];
}

type Video = NonNullable<SiteProduct["videos"]>[number];
type Probe = (file: string) => string;

const sidecarPlainError =
  "Generate site/media/routines-demo.json or install ffprobe to measure routines-demo.mp4.";

function ffprobe(file: string): string {
  try {
    return execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error instanceof Error && error.message.includes("ENOENT"))
    ) {
      throw new Error(sidecarPlainError);
    }
    throw error;
  }
}

export async function videosFromMedia(rootDir = root, probe: Probe = ffprobe): Promise<Video[]> {
  const files: Video["files"] = {
    mp4: "media/routines-demo.mp4",
    webm: "media/routines-demo.webm",
    poster: "media/routines-demo.jpg",
    captions: "media/routines-demo.en.vtt",
  };
  const missing = await Promise.all(
    Object.values(files).map(async (file) => {
      const info = await stat(path.join(rootDir, "site", file)).catch(() => null);
      return info?.isFile() ? null : file;
    }),
  );
  if (missing.some(Boolean)) {
    console.log(`Skipping routines-demo video: missing ${missing.filter(Boolean).join(", ")}.`);
    return [];
  }
  const sidecarPath = path.join(rootDir, "site/media/routines-demo.json");
  let sidecarContent: string | null = null;
  try {
    sidecarContent = await readFile(sidecarPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  let width: number | undefined;
  let height: number | undefined;
  let durationSeconds: number | undefined;

  if (sidecarContent !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sidecarContent);
    } catch {
      throw new Error("site/media/routines-demo.json is not valid JSON.");
    }
    const sidecar = (parsed ?? {}) as {
      durationSeconds?: unknown;
      width?: unknown;
      height?: unknown;
      mp4Sha256?: unknown;
    };
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Number.isInteger(sidecar.width) ||
      (sidecar.width as number) <= 0 ||
      !Number.isInteger(sidecar.height) ||
      (sidecar.height as number) <= 0 ||
      typeof sidecar.durationSeconds !== "number" ||
      !Number.isFinite(sidecar.durationSeconds) ||
      sidecar.durationSeconds <= 0
    ) {
      throw new Error(
        "site/media/routines-demo.json must contain positive integer width and height and finite positive durationSeconds.",
      );
    }
    const mp4Bytes = await readFile(path.join(rootDir, "site", files.mp4));
    const mp4Sha256 = createHash("sha256").update(mp4Bytes).digest("hex");
    if (typeof sidecar.mp4Sha256 !== "string" || sidecar.mp4Sha256 !== mp4Sha256) {
      throw new Error(
        "site/media/routines-demo.json describes a different routines-demo.mp4; re-run the export.",
      );
    }
    width = sidecar.width as number;
    height = sidecar.height as number;
    durationSeconds = sidecar.durationSeconds;
  } else {
    let probeOutput: string;
    try {
      probeOutput = probe(path.join(rootDir, "site", files.mp4));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error instanceof Error && error.message.includes("ENOENT"))
      ) {
        throw new Error(sidecarPlainError);
      }
      throw error;
    }
    const measured = JSON.parse(probeOutput) as {
      streams?: { width?: number; height?: number }[];
      format?: { duration?: string };
    };
    const probeWidth = measured.streams?.[0]?.width;
    const probeHeight = measured.streams?.[0]?.height;
    const probeDuration = Number(measured.format?.duration);
    if (
      !Number.isInteger(probeWidth) ||
      !Number.isInteger(probeHeight) ||
      !Number.isFinite(probeDuration) ||
      probeDuration <= 0
    ) {
      throw new Error("ffprobe could not measure routines-demo.mp4 duration and dimensions.");
    }
    width = probeWidth;
    height = probeHeight;
    durationSeconds = probeDuration;
  }

  return [
    {
      id: "routines-demo",
      title: "A routine from setup to result",
      description:
        "A Briefing bot creates a Morning checklist routine from sample notes, schedules it for weekdays at 8:00 AM UTC, saves it, runs it once, and shows three checklist bullets and a completed Run history entry.",
      durationSeconds,
      width,
      height,
      files,
    },
  ];
}

export async function generatedProduct(rootDir = root, docsRoot = rootDir): Promise<SiteProduct> {
  const input = JSON.parse(await readFile(path.join(rootDir, productPath), "utf8"));
  const {
    generatedAt: _generatedAt,
    source: _source,
    videos: _videos,
    documentation: _documentation,
    ...curated
  } = input;
  const documentation = publishedDocumentation(await loadValidatedFeatureDocs(docsRoot));
  const videos = await videosFromMedia(rootDir);
  const casks = (await readdir(path.join(rootDir, "homebrew/Casks"))).filter((name) =>
    name.endsWith(".rb"),
  );
  if (casks.length !== 1)
    throw new Error(
      "Expected one cask in homebrew/Casks; update scripts/site-facts.ts for multiple casks.",
    );
  const cask = casks[0].slice(0, -3);
  const result = {
    ...curated,
    documentation,
    ...(curated.memory ? { memory: { ...curated.memory, ...memoryFromCode() } } : {}),
    ...(videos.length ? { videos } : {}),
    providers: providersFromCatalog(),
    computers: computersFromRegistry(),
    routines: {
      ...routinesFromCode(),
      ...(curated.routines?.useCases ? { useCases: curated.routines.useCases } : {}),
    },
    install: {
      ...curated.install,
      homebrew: {
        ...curated.install.homebrew,
        caskPath: `Casks/${casks[0]}`,
        command: `brew install --cask ardurai/tap/${cask}`,
      },
    },
  };
  return SiteProductSchema.parse(result);
}

function replaceBlock(readme: string, id: string, content: string): string {
  const start = `<!-- site-facts:${id}:start -->`;
  const end = `<!-- site-facts:${id}:end -->`;
  const first = readme.indexOf(start);
  const last = readme.indexOf(end);
  if (
    first < 0 ||
    last < first ||
    readme.indexOf(start, first + 1) !== -1 ||
    readme.indexOf(end, last + 1) !== -1
  ) {
    throw new Error(
      `README.md needs exactly one ${start} and ${end} marker. Run pnpm site:facts after restoring them.`,
    );
  }
  return `${readme.slice(0, first)}${start}\n${generatedComment}\n${content}\n${end}${readme.slice(last + end.length)}`;
}

export function generatedReadme(readme: string, product: SiteProduct): string {
  const available = product.providers.filter((provider) => provider.status === "available");
  const featured = POPULAR_MODEL_PROVIDER_IDS.map((id) => {
    const provider = available.find((entry) => entry.id === id && entry.featured);
    if (!provider)
      throw new Error(`Featured provider "${id}" is missing from site/data/product.json.`);
    return provider.accountHint ? `${provider.name} (${provider.accountHint})` : provider.name;
  });
  const more = available.length - featured.length;
  const planned = product.providers
    .filter((provider) => provider.status === "roadmap")
    .map((provider) =>
      provider.id === "ollama" ? "Ollama as a direct local choice" : provider.name,
    );
  const providerText = [
    `- Providers: ${featured.slice(0, 3).join(", ")},`,
    `  ${featured.slice(3).join(", ")}, and ${more} more in the searchable model catalog.`,
    "  OpenAI-compatible servers cover local Ollama, LM Studio and llama.cpp.",
    `  Planned additions include ${planned.join(" and ")}.`,
  ].join("\n");
  const fromSource = product.install.fromSource;
  const split = fromSource.commands.indexOf("cp .env.example .env") + 1;
  if (!split || split === fromSource.commands.length)
    throw new Error(
      "install.fromSource.commands must include setup commands before service commands.",
    );
  const sourceText = [
    `You need ${fromSource.requirements.replace(", Node.js 24.x", ",\nNode.js 24.x")}. Node.js 23.x and 25.x are not supported.`,
    "",
    "```sh",
    ...fromSource.commands.slice(0, split),
    "```",
    "",
    fromSource.note
      .replace(/\.env\b/g, "`.env`")
      .replace(
        /\b(POSTGRES_PASSWORD|DATABASE_URL|BETTER_AUTH_SECRET|ENCRYPTION_KEY|SCREEN_PROXY_SECRET|SANDBOX_SUPERVISOR_TOKEN|OPENROUTER_API_KEY|openssl rand -hex (?:16|32))\b/g,
        "`$1`",
      )
      .replace(" and use it in `DATABASE_URL`", " and put the same value in `DATABASE_URL`")
      .replace("; set ", ". Set ")
      .replace("; add ", ". Add ")
      .replace(" and put the same value", "\nand put the same value")
      .replace(". Set ", ".\nSet ")
      .replace(" and `SANDBOX_SUPERVISOR_TOKEN`", "\nand `SANDBOX_SUPERVISOR_TOKEN`")
      .replace(". Add model credentials", ".\nAdd model credentials"),
    "",
    "```sh",
    ...fromSource.commands
      .slice(split)
      .map((command) =>
        command.startsWith("docker compose ")
          ? command
              .replace(/ -f /g, " \\\n  -f ")
              .replace(/ up postgres -d$/, " \\\n  up postgres -d")
          : command,
      ),
    "```",
  ].join("\n");
  return replaceBlock(replaceBlock(readme, "providers", providerText), "from-source", sourceText);
}

export async function validateReferences(product: SiteProduct, rootDir = root): Promise<void> {
  const readme = await readFile(path.join(rootDir, readmePath), "utf8");
  const readmeHeadings = new Set(
    [...readme.matchAll(/^#{1,6} (.+)$/gm)].map((match) => match[1].trim()),
  );
  if (product.memory) {
    for (const entry of [...product.memory.sections, ...product.memory.proofPoints]) {
      const heading = entry.source.startsWith("README.md#")
        ? entry.source.slice("README.md#".length)
        : "";
      if (!heading || !readmeHeadings.has(heading)) {
        throw new Error(`Memory "${entry.id}" points at missing README heading ${entry.source}.`);
      }
    }
    for (const section of product.memory.sections) {
      if (!section.qualification.trim()) {
        throw new Error(`Memory section "${section.id}" needs a qualification.`);
      }
    }
    const strings = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap(strings);
      if (value && typeof value === "object") return Object.values(value).flatMap(strings);
      return [];
    };
    for (const value of strings(product.memory)) {
      const denied = MEMORY_DENIED_PHRASES.find((phrase) => value.toLowerCase().includes(phrase));
      if (denied) throw new Error(`Memory copy contains denied phrase "${denied}".`);
    }
  }
  for (const feature of product.features) {
    const [file, section] = feature.source.split("#");
    if (!file || !["README.md", "VISION.md", "docs/self-host.md"].includes(file)) {
      throw new Error(`Feature "${feature.id}" has an unsupported source: ${feature.source}.`);
    }
    const body = await readFile(path.join(rootDir, file), "utf8").catch(() => {
      throw new Error(`Feature "${feature.id}" points at missing file ${file}.`);
    });
    if (
      section &&
      !body
        .split("\n")
        .some((line) => /^#{1,6} /.test(line) && line.replace(/^#{1,6} /, "").trim() === section)
    ) {
      throw new Error(`Feature "${feature.id}" points at missing section ${feature.source}.`);
    }
  }
  const spec = await readFile(path.join(rootDir, screenshotSpec), "utf8");
  const captures = [...spec.matchAll(/captureSiteScreenshot\(page, "([a-z0-9-]+)"\)/g)].map(
    (match) => match[1],
  );
  for (const shot of product.screenshots) {
    if (!captures.includes(shot.id)) {
      throw new Error(
        `Screenshot "${shot.id}" has no capture in ${screenshotSpec}. Add captureSiteScreenshot(page, "${shot.id}").`,
      );
    }
  }
  if (product.memory) {
    const screenshot = product.memory.settingsPath.screenshot;
    if (!product.screenshots.some((shot) => shot.id === screenshot)) {
      throw new Error(`Memory screenshot "${screenshot}" is not in screenshots.`);
    }
  }
  const catalog = await readFile(path.join(rootDir, "apps/web/src/locales/en/messages.po"), "utf8");
  const labels = new Set(
    [...catalog.matchAll(/^msgid "([^"\\]*(?:\\.[^"\\]*)*)"$/gm)].map((match) => match[1]),
  );
  if (product.memory) {
    for (const label of product.memory.settingsPath.uiLabels) {
      if (!labels.has(label)) {
        throw new Error(
          `Memory settings UI label "${label}" missing from the English message catalog.`,
        );
      }
      if (!product.memory.settingsPath.steps.includes(label)) {
        throw new Error(`Memory settings UI label "${label}" must appear in settingsPath.steps.`);
      }
    }
  }
  if (product.routines?.useCases) {
    for (const useCase of product.routines.useCases) {
      for (const label of useCase.uiLabels) {
        if (!labels.has(label))
          throw new Error(
            `Routine use case "${useCase.id}" uses UI label "${label}" missing from the English message catalog.`,
          );
        if (!useCase.steps.some((step) => step.includes(`“${label}”`)))
          throw new Error(
            `Routine use case "${useCase.id}" must use UI label "${label}" verbatim in a step.`,
          );
      }
      for (const step of useCase.steps) {
        for (const match of step.matchAll(/“([^”]+)”/g)) {
          if (!useCase.uiLabels.includes(match[1]))
            throw new Error(
              `Routine use case "${useCase.id}" names control "${match[1]}" without listing its UI label.`,
            );
        }
      }
    }
  }
  for (const video of product.videos ?? []) {
    for (const file of Object.values(video.files)) {
      const asset = path.join(rootDir, "site", file);
      const info = await stat(asset).catch(() => {
        throw new Error(`Video "${video.id}" is missing site/${file}.`);
      });
      if (!info.isFile() || info.size > 8_000_000)
        throw new Error(`Video "${video.id}" file site/${file} must be a file at most 8 MB.`);
    }
    const captions = await readFile(path.join(rootDir, "site", video.files.captions), "utf8");
    if (!captions.startsWith("WEBVTT"))
      throw new Error(`Video "${video.id}" needs WEBVTT captions.`);
  }
}

export async function runSiteFacts(
  mode: "write" | "check",
  rootDir = root,
  docsRoot = rootDir,
): Promise<boolean> {
  const currentProduct = await readFile(path.join(rootDir, productPath), "utf8");
  const currentReadme = await readFile(path.join(rootDir, readmePath), "utf8");
  const input = JSON.parse(currentProduct);
  if (mode === "check" && (input.generatedAt || input.source)) {
    throw new Error(
      `${productPath} must omit generatedAt and source. Run \`pnpm site:facts\` and commit the result.`,
    );
  }
  const product = await generatedProduct(rootDir, docsRoot);
  await validateReferences(product, rootDir);
  const expectedProduct = `${JSON.stringify(product, null, 2)}\n`;
  const expectedReadme = generatedReadme(currentReadme, product);
  const stale = currentProduct !== expectedProduct || currentReadme !== expectedReadme;
  if (mode === "check") {
    if (currentProduct !== expectedProduct)
      throw new Error(
        `${productPath} is stale. Run \`pnpm site:facts\` and commit the result. Curated text lives in ${productPath}.`,
      );
    if (currentReadme !== expectedReadme)
      throw new Error(
        "README.md site facts blocks are stale. Run `pnpm site:facts` and commit the result. Curated text lives in site/data/product.json.",
      );
  } else if (stale) {
    if (currentProduct !== expectedProduct)
      await writeFile(path.join(rootDir, productPath), expectedProduct);
    if (currentReadme !== expectedReadme)
      await writeFile(path.join(rootDir, readmePath), expectedReadme);
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] === "--check" ? "check" : "write";
  runSiteFacts(mode)
    .then((changed) => {
      console.log(
        mode === "check"
          ? "Site facts are current."
          : changed
            ? "Site facts updated."
            : "Site facts unchanged.",
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
