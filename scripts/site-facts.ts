import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPiCatalog } from "../packages/adapters/src/pi-models.ts";
import { ComputerConnectionSettingsSchema } from "../packages/contracts/src/computer-connections.ts";
import { type SiteProduct, SiteProductSchema } from "../packages/contracts/src/site-product.ts";

type Provider = SiteProduct["providers"][number];
type ProviderMetadata = Pick<Provider, "name" | "access" | "status">;

// Every shipped catalog ID must be described here. Do not infer access from an OAuth flag:
// the catalog also contains key-only and compatibility paths for subscription vendors.
export const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  "amazon-bedrock": { name: "Amazon Bedrock", access: "api-key", status: "available" },
  "ant-ling": { name: "Ant Ling", access: "api-key", status: "available" },
  anthropic: { name: "Anthropic", access: "api-key", status: "available" },
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
  "github-copilot": { name: "GitHub Copilot", access: "subscription", status: "available" },
  google: { name: "Google", access: "api-key", status: "available" },
  "google-vertex": { name: "Google Vertex AI", access: "api-key", status: "available" },
  groq: { name: "Groq", access: "api-key", status: "available" },
  huggingface: { name: "Hugging Face", access: "api-key", status: "available" },
  "kimi-coding": { name: "Kimi for Coding", access: "subscription", status: "available" },
  meta: { name: "Meta", access: "subscription", status: "available" },
  minimax: { name: "MiniMax", access: "api-key", status: "available" },
  "minimax-cn": { name: "MiniMax CN", access: "api-key", status: "available" },
  mistral: { name: "Mistral", access: "api-key", status: "available" },
  moonshotai: { name: "Moonshot AI", access: "api-key", status: "available" },
  "moonshotai-cn": { name: "Moonshot AI CN", access: "api-key", status: "available" },
  nvidia: { name: "NVIDIA", access: "api-key", status: "available" },
  openai: { name: "OpenAI", access: "api-key", status: "available" },
  "openai-codex": { name: "OpenAI Codex", access: "subscription", status: "available" },
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
  xai: { name: "xAI", access: "subscription", status: "available" },
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
  },
  ollama: { name: "Ollama as a first-class choice", access: "local", status: "roadmap" },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productPath = "site/data/product.json";
const readmePath = "README.md";
const screenshotSpec = "apps/web/e2e/site-screenshots.spec.ts";
const generatedComment =
  "<!-- Generated from site/data/product.json by pnpm site:facts; edit that file. -->";

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
  return Object.entries(PROVIDER_METADATA)
    .filter(([id, metadata]) => shipped.includes(id) || metadata.status === "roadmap")
    .map(([id, metadata]) => ({ id, ...metadata }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

export async function generatedProduct(rootDir = root): Promise<SiteProduct> {
  const input = JSON.parse(await readFile(path.join(rootDir, productPath), "utf8"));
  const { generatedAt: _generatedAt, source: _source, ...curated } = input;
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
    providers: providersFromCatalog(),
    computers: computersFromRegistry(),
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
  const featured = [
    "openrouter",
    "openai-codex",
    "anthropic",
    "openai",
    "google",
    "vercel-ai-gateway",
    "openai-compatible",
  ].map((id) => {
    const provider = available.find((entry) => entry.id === id);
    if (!provider)
      throw new Error(`Featured provider "${id}" is missing from site/data/product.json.`);
    return provider.name;
  });
  const more = available.length - featured.length;
  const planned = product.providers
    .filter((provider) => provider.status === "roadmap")
    .map((provider) => provider.name);
  const providerText = [
    `- Providers: ${featured.slice(0, -1).join(", ")}, and ${featured.at(-1)},`,
    `  plus ${more} more in the model catalog. OpenAI-compatible servers cover local Ollama,`,
    "  LM Studio and llama.cpp. The planned first-class options are",
    `  ${planned.join(" and ")}.`,
  ].join("\n");
  const fromSource = product.install.fromSource;
  const split = fromSource.commands.indexOf("cp .env.example .env") + 1;
  if (!split || split === fromSource.commands.length)
    throw new Error(
      "install.fromSource.commands must include setup commands before service commands.",
    );
  const sourceText = [
    `You need ${fromSource.requirements}. Node.js 23.x and 25.x are not supported.`,
    "",
    "```sh",
    ...fromSource.commands.slice(0, split),
    "```",
    "",
    fromSource.note,
    "",
    "```sh",
    ...fromSource.commands.slice(split),
    "```",
  ].join("\n");
  return replaceBlock(replaceBlock(readme, "providers", providerText), "from-source", sourceText);
}

export async function validateReferences(product: SiteProduct, rootDir = root): Promise<void> {
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
}

export async function runSiteFacts(mode: "write" | "check", rootDir = root): Promise<boolean> {
  const currentProduct = await readFile(path.join(rootDir, productPath), "utf8");
  const currentReadme = await readFile(path.join(rootDir, readmePath), "utf8");
  const input = SiteProductSchema.safeParse(JSON.parse(currentProduct));
  if (mode === "check" && !input.success) {
    throw new Error(
      `${productPath} violates the site facts contract: ${input.error.message}. Fix curated fields and run pnpm site:facts.`,
    );
  }
  if (mode === "check" && (input.data?.generatedAt || input.data?.source)) {
    throw new Error(
      `${productPath} must omit generatedAt and source. Run \`pnpm site:facts\` and commit the result.`,
    );
  }
  const product = await generatedProduct(rootDir);
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
