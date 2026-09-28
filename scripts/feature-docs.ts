import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import type {
  FeatureDocumentationEvidence,
  FeatureDocumentationManifest,
} from "../packages/contracts/src/feature-documentation";
import {
  FeatureDocumentationEvidenceSchema,
  FeatureDocumentationManifestSchema,
} from "../packages/contracts/src/feature-documentation";
import { SiteDocumentationSchema } from "../packages/contracts/src/site-product";
import { validatePngScreenshot } from "../packages/testkit/src/png-validation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = "site/data/feature-docs.json";
const evidenceFile = "site/data/feature-docs-evidence.json";
const settingsFile = "apps/web/src/pages/settings-sections.ts";
const webRoutesFile = "apps/web/src/App.tsx";
const mobileLayoutFile = "apps/mobile/app/_layout.tsx";
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The website's documentation areas, in its display order; any other area drops the whole block. */
const websiteAreas = new Set([
  "getting-started",
  "bots-and-conversations",
  "team-work",
  "routines-and-boards",
  "memory-and-learning",
  "connections-and-computers",
  "desktop",
  "mobile",
  "ide-and-operations",
]);
const allowedExemptions = {
  webRoutes: new Set(["/mcp/oauth/callback", "*"]),
  mobileEntries: new Set(["board", "connectors"]),
};
const nameDenylist =
  /\b(?:Claude|ChatGPT|OpenAI|Codex|Gemini|Anthropic|Ollama|Llama|DeepSeek|Copilot|Perplexity)\b/i;
const claimDenylist =
  /\b(?:best|fastest|seamless|effortless|ultimate|guaranteed|always|never|all your|powered by|created by|built by)\b/i;
const markup = /<[^>]+>|\[[^\]]*\]|[`*_#\r\n]|^\s*[-+]\s/m;
const deniedPhrases = [
  "every memory",
  "instant sync",
  "works with any repo",
  "edits in every app automatically sync",
  "secrets can never leak",
  "tamper-proof",
  "private folders inside a shared repo",
  "all your skills and plugins travel with memory",
];
const compareSlug = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type FeatureEvidence = FeatureDocumentationEvidence;

function assertPlain(value: string, context: string): void {
  if (
    markup.test(value) ||
    nameDenylist.test(value) ||
    claimDenylist.test(value) ||
    deniedPhrases.some((phrase) => value.toLowerCase().includes(phrase))
  ) {
    throw new Error(`${context} must be plain, neutral public copy.`);
  }
}

function assertUnique(values: string[], context: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!slug.test(value)) throw new Error(`${context} has invalid slug "${value}".`);
    if (seen.has(value)) throw new Error(`${context} repeats "${value}".`);
    seen.add(value);
  }
}

function catalogLabels(po: string): Set<string> {
  // PO strings can continue over quoted lines. JSON string decoding handles PO's common escapes.
  const labels = new Set<string>();
  const lines = po.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.startsWith('msgid "')) continue;
    let value = JSON.parse(lines[i]!.slice(6)) as string;
    while (lines[i + 1]?.startsWith('"')) value += JSON.parse(lines[++i]!) as string;
    if (value) labels.add(value);
  }
  return labels;
}

function catalogOwners(po: string, sentence: string): Set<string> {
  const owners = new Set<string>();
  const lines = po.split(/\r?\n/);
  let references: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#: ")) {
      references.push(...line.slice(3).split(/\s+/));
      continue;
    }
    if (line.startsWith('msgid "')) {
      let value = JSON.parse(line.slice(6)) as string;
      while (lines[i + 1]?.startsWith('"')) value += JSON.parse(lines[++i]!) as string;
      if (value === sentence)
        for (const reference of references) owners.add(`apps/web/${reference}`);
      references = [];
    } else if (!line.startsWith("#") && line.trim()) {
      references = [];
    }
  }
  return owners;
}

export function assertCitedErrorSentence(
  sentence: string,
  sourcePath: string,
  source: string,
  catalogPath: string | undefined,
  englishCatalog: string,
  context: string,
): void {
  if (!source.includes(sentence))
    throw new Error(`${context} is not verbatim in its cited source.`);
  if (catalogPath) {
    if (catalogPath !== "apps/web/src/locales/en/messages.po")
      throw new Error(`${context} cites an unsupported catalog.`);
    if (!catalogOwners(englishCatalog, sentence).has(sourcePath))
      throw new Error(`${context} is not owned by its cited source in the catalog.`);
  }
}

function sourceSet(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]!));
}

function assertCoverage(
  kind: "settings" | "webRoutes" | "mobileEntries",
  actual: Set<string>,
  mappings: Record<string, string>,
  exemptions: Record<string, string>,
  ids: Set<string>,
  internal: Set<string>,
): void {
  const declared = new Set([...Object.keys(mappings), ...Object.keys(exemptions)]);
  for (const key of actual) {
    if (!declared.has(key))
      throw new Error(`${kind} "${key}" has no feature mapping or exemption.`);
  }
  for (const key of declared) {
    if (!actual.has(key)) throw new Error(`${kind} "${key}" is no longer registered.`);
    if (Object.hasOwn(mappings, key) && Object.hasOwn(exemptions, key))
      throw new Error(`${kind} "${key}" is both mapped and exempt.`);
  }
  for (const [key, id] of Object.entries(mappings)) {
    if (!ids.has(id) || internal.has(id))
      throw new Error(`${kind} "${key}" points at missing or internal feature "${id}".`);
  }
  for (const [key, reason] of Object.entries(exemptions)) {
    if (kind === "settings" || !allowedExemptions[kind].has(key) || !reason.trim())
      throw new Error(`${kind} "${key}" is not an allowed, justified exemption.`);
  }
}

async function existingRelativeBytes(
  rootDir: string,
  file: string,
  context: string,
): Promise<Buffer> {
  if (path.isAbsolute(file) || file.split("/").includes("..") || file.includes("\\"))
    throw new Error(`${context} must use a repository-relative path.`);
  const absolute = path.resolve(rootDir, file);
  if (!absolute.startsWith(`${path.resolve(rootDir)}${path.sep}`))
    throw new Error(`${context} escapes the repository.`);
  if (!(await stat(absolute).catch(() => null))?.isFile())
    throw new Error(`${context} points at missing file ${file}.`);
  const resolved = await realpath(absolute);
  if (!resolved.startsWith(`${await realpath(rootDir)}${path.sep}`))
    throw new Error(`${context} resolves outside the repository.`);
  return readFile(absolute);
}

async function existingRelativeFile(
  rootDir: string,
  file: string,
  context: string,
): Promise<string> {
  return (await existingRelativeBytes(rootDir, file, context)).toString("utf8");
}

export function assertDocumentationPng(
  bytes: Buffer,
  width: number,
  height: number,
  file: string,
): void {
  const invalid = () => {
    throw new Error(`${file} must be a ${width}x${height} PNG no larger than 250 KB.`);
  };
  if (bytes.length > 250_000) invalid();
  try {
    validatePngScreenshot(bytes, file);
    if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) invalid();
    assertExactImageData(bytes, width, height);
  } catch {
    invalid();
  }
}

/**
 * The shared decoder proves the picture decodes; this proves the compressed image data is exactly
 * the picture and nothing else. A strict inflate verifies the zlib header and checksum on every Node
 * release, and the inflated length must equal the filtered raster size for the declared header.
 */
function assertExactImageData(bytes: Buffer, width: number, height: number): void {
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const interlace = bytes[28]!;
  const channels = colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 1;
  const rowBytes = (columns: number) => 1 + Math.ceil((columns * bitDepth * channels) / 8);
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const columns = Math.max(0, Math.ceil((width - x!) / dx!));
    const rows = Math.max(0, Math.ceil((height - y!) / dy!));
    if (columns && rows) expected += rows * rowBytes(columns);
  }
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT")
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  if (!idat.length) throw new Error("PNG has no image data.");
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error("PNG image data does not match its header.");
}

/** The published projection contains only Addendum D fields. */
export function publishedDocumentation(manifest: FeatureDocumentationManifest) {
  const published = manifest.features
    .filter((feature) => feature.status === "published" && !feature.internal)
    .sort((a, b) => compareSlug(a.area, b.area) || a.order - b.order || compareSlug(a.id, b.id));
  // Nothing published means no block at all: the website rejects an empty one.
  if (published.length === 0) return undefined;
  const features = published.map((feature) => ({
    id: feature.id,
    aliases: feature.aliases,
    title: feature.title,
    summary: feature.summary,
    area: feature.area,
    order: feature.order,
    status: "published" as const,
    availableSince: feature.availableSince,
    platforms: feature.platforms,
    settingsPath: Object.fromEntries(
      Object.entries(feature.settingsPath)
        .filter(([, value]) => Boolean(value))
        .map(([platform, value]) => [platform, value!.uiLabels]),
    ),
    steps: feature.steps.map(
      ({ id, aliases, text, uiLabels, screenshotId, expected, availableSince }) => ({
        id,
        aliases,
        text,
        uiLabels,
        screenshotId: screenshotId!,
        expected,
        availableSince,
      }),
    ),
    boundaries: feature.boundaries,
    troubleshooting: feature.troubleshooting,
    related: feature.related.filter((id) => !feature.deferredRelated?.includes(id)),
  }));
  const used = new Set(
    features.flatMap((feature) => feature.steps.map((step) => step.screenshotId)),
  );
  const screenshots = manifest.screenshots
    .filter((shot) => used.has(shot.id))
    .sort((a, b) => compareSlug(a.id, b.id))
    .map(({ id, file, alt, width, height, crop, platform, theme, feature, step }) => ({
      id,
      file,
      alt,
      width,
      height,
      crop,
      platform,
      theme,
      feature,
      step,
    }));
  return SiteDocumentationSchema.parse({
    manifestVersion: manifest.manifestVersion,
    locale: manifest.locale,
    features,
    screenshots,
  });
}

/** Validate a draft authoring snapshot against the current checkout, without network or writes. */
export async function validateFeatureDocs(
  input: unknown,
  evidence: FeatureEvidence,
  rootDir = root,
  readCapture = (file: string, context: string) => existingRelativeBytes(rootDir, file, context),
): Promise<FeatureDocumentationManifest> {
  const manifest = FeatureDocumentationManifestSchema.parse(input);
  evidence = FeatureDocumentationEvidenceSchema.parse(evidence);
  const ids = manifest.features.map((feature) => feature.id);
  assertUnique(ids, "Feature IDs");
  const idSet = new Set(ids);
  const internal = new Set(
    manifest.features.filter((feature) => feature.internal).map((f) => f.id),
  );
  const allNames = new Set(ids);
  const areas = new Map<string, Set<number>>();
  const englishCatalog = await existingRelativeFile(
    rootDir,
    "apps/web/src/locales/en/messages.po",
    "English catalog",
  );
  const labels = catalogLabels(englishCatalog);
  const mobileLayout = await existingRelativeFile(rootDir, mobileLayoutFile, "Mobile layout");
  const settingsSource = await existingRelativeFile(rootDir, settingsFile, "Settings registry");
  const webSource = await existingRelativeFile(rootDir, webRoutesFile, "Web routes");
  const settings = sourceSet(settingsSource, /\{\s*id: "([a-z-]+)"/g);
  const webRoutes = sourceSet(webSource, /<Route\b[^>]*?\bpath="([^"]+)"/gs);
  const layoutEntries = sourceSet(mobileLayout, /<Stack\.Screen\b[^>]*?\bname="([^"]+)"/gs);
  const mobileFiles = new Set(
    (await readdir(path.join(rootDir, "apps/mobile/app")))
      .filter((file) => file.endsWith(".tsx") && file !== "_layout.tsx")
      .map((file) => file.slice(0, -4)),
  );
  for (const entry of layoutEntries) {
    if (!mobileFiles.has(entry)) throw new Error(`Mobile layout "${entry}" has no route file.`);
  }
  assertCoverage("settings", settings, evidence.coverage.settings, {}, idSet, internal);
  assertCoverage(
    "webRoutes",
    webRoutes,
    evidence.coverage.webRoutes,
    evidence.exemptions.webRoutes,
    idSet,
    internal,
  );
  assertCoverage(
    "mobileEntries",
    mobileFiles,
    evidence.coverage.mobileEntries,
    evidence.exemptions.mobileEntries,
    idSet,
    internal,
  );
  const evidenceById = new Map(evidence.features.map((item) => [item.id, item]));
  assertUnique(
    evidence.features.map((item) => item.id),
    "Evidence IDs",
  );
  for (const id of evidenceById.keys())
    if (!idSet.has(id)) throw new Error(`Evidence has unknown feature "${id}".`);
  const screenshots = new Map(manifest.screenshots.map((shot) => [shot.id, shot]));
  assertUnique(
    manifest.screenshots.map((shot) => shot.id),
    "Screenshot IDs",
  );
  assertUnique(
    evidence.screenshots.map((shot) => shot.id),
    "Screenshot evidence IDs",
  );
  const screenshotHashes = new Map(evidence.screenshots.map((shot) => [shot.id, shot.sha256]));
  for (const id of screenshotHashes.keys())
    if (!screenshots.has(id)) throw new Error(`Screenshot evidence has unknown capture "${id}".`);
  const usedScreenshots = new Set<string>();
  for (const feature of manifest.features) {
    const context = `Feature "${feature.id}"`;
    if (!websiteAreas.has(feature.area))
      throw new Error(`${context} area "${feature.area}" is not one of the website's areas.`);
    const binding = evidenceById.get(feature.id);
    if (!binding) throw new Error(`${context} has no evidence binding.`);
    const nativeSources = binding.sources.filter((file) => file.startsWith("apps/mobile/"));
    const nativeLabel = async (label: string): Promise<boolean> => {
      for (const file of nativeSources) {
        if (
          (await existingRelativeFile(rootDir, file, `${context} native source`)).includes(
            JSON.stringify(label),
          )
        )
          return true;
      }
      return mobileLayout.includes(JSON.stringify(label));
    };
    if (feature.internal !== Boolean(feature.internalReason))
      throw new Error(`${context} needs an internal reason exactly when internal.`);
    if (feature.internalReason) assertPlain(feature.internalReason, `${context} internal reason`);
    if (
      feature.internal &&
      Object.values(feature.platforms).some((state) => state !== "unavailable")
    )
      throw new Error(`${context} is internal but declares a reachable platform.`);
    if (feature.status === "published" && (feature.internal || !feature.steps.length))
      throw new Error(`${context} cannot publish without verified steps.`);
    const orders = areas.get(feature.area) ?? new Set<number>();
    if (orders.has(feature.order))
      throw new Error(`${context} repeats order ${feature.order} in ${feature.area}.`);
    orders.add(feature.order);
    areas.set(feature.area, orders);
    for (const [name, value] of Object.entries({ title: feature.title, summary: feature.summary }))
      assertPlain(value, `${context} ${name}`);
    const titleInNative =
      feature.status === "draft" || feature.settingsPath.mobile
        ? await nativeLabel(feature.title)
        : false;
    if (feature.titleSource === "guide") {
      if (
        feature.internal ||
        Object.values(feature.settingsPath).some(Boolean) ||
        !binding.titleSource?.endsWith(".md") ||
        !binding.sources.includes(binding.titleSource)
      )
        throw new Error(`${context} guide title needs a cited Markdown source and no UI path.`);
      const guide = await existingRelativeFile(
        rootDir,
        binding.titleSource,
        `${context} guide title`,
      );
      if (
        !guide
          .split(/\r?\n/)
          .some((line) => /^#{1,6} /.test(line) && line.replace(/^#{1,6} /, "") === feature.title)
      )
        throw new Error(`${context} title "${feature.title}" does not match its cited heading.`);
    } else if (binding.titleSource) {
      throw new Error(`${context} title source requires an explicit guide title.`);
    } else if (!feature.internal && !labels.has(feature.title) && !titleInNative)
      throw new Error(`${context} title "${feature.title}" is not a current UI label.`);
    for (const alias of feature.aliases) {
      if (allNames.has(alias))
        throw new Error(`${context} alias "${alias}" collides with an ID or alias.`);
      allNames.add(alias);
    }
    const stepIds = feature.steps.map((step) => step.id);
    assertUnique(stepIds, `${context} step IDs`);
    const stepNames = new Set(stepIds);
    for (const step of feature.steps) {
      for (const alias of step.aliases) {
        if (stepNames.has(alias)) throw new Error(`${context} step alias "${alias}" collides.`);
        stepNames.add(alias);
      }
      for (const [name, value] of Object.entries({ text: step.text, expected: step.expected }))
        assertPlain(value, `${context} step "${step.id}" ${name}`);
      for (const named of step.text.matchAll(/“([^”]+)”/g))
        if (!step.uiLabels.includes(named[1]!))
          throw new Error(`${context} step "${step.id}" names an unlisted UI label.`);
      for (const label of step.uiLabels) {
        if (!labels.has(label) && (!feature.settingsPath.mobile || !(await nativeLabel(label))))
          throw new Error(
            `${context} step "${step.id}" label "${label}" is absent from English UI sources.`,
          );
      }
      if (step.screenshotId) {
        const shot = screenshots.get(step.screenshotId);
        if (!shot || shot.feature !== feature.id || shot.step !== step.id)
          throw new Error(
            `${context} step "${step.id}" has no matching screenshot ${step.screenshotId}.`,
          );
        usedScreenshots.add(shot.id);
      } else if (feature.status === "published") {
        throw new Error(`${context} published step "${step.id}" needs a screenshot.`);
      }
    }
    for (const [platform, entry] of Object.entries(feature.settingsPath)) {
      if (!entry) continue;
      // The website accepts a path only where the platform is configurable; a read-only screen has none.
      if (feature.platforms[platform as keyof typeof feature.platforms] !== "configure")
        throw new Error(`${context} has a ${platform} path but is not configurable there.`);
      if (entry.entry.kind === "settings" && !settings.has(entry.entry.sectionId))
        throw new Error(
          `${context} references unknown settings section "${entry.entry.sectionId}".`,
        );
      if (entry.entry.kind === "route") {
        const route = entry.entry.route;
        if (platform === "mobile" ? !mobileFiles.has(route.slice(1)) : !webRoutes.has(route))
          throw new Error(`${context} references unknown ${platform} route "${route}".`);
      }
      let mobileSource = "";
      if (platform === "mobile" && entry.entry.kind === "route")
        mobileSource = `${mobileLayout}\n${await existingRelativeFile(rootDir, `apps/mobile/app/${entry.entry.route.slice(1)}.tsx`, context)}`;
      for (const label of entry.uiLabels) {
        assertPlain(label, `${context} ${platform} path label`);
        if (
          platform === "mobile" ? !mobileSource.includes(JSON.stringify(label)) : !labels.has(label)
        )
          throw new Error(
            `${context} ${platform} path label "${label}" is absent from its English UI source.`,
          );
      }
      if (entry.entry.kind === "settings") {
        const section = settingsSource.match(
          new RegExp(
            `\\{ id: "${entry.entry.sectionId}"[^\\n]*group: "([^"]+)"[^\\n]*label: msg\x60([^\x60]+)\x60`,
          ),
        );
        const expected = section
          ? ["Settings", ...(section[1] === "Settings" ? [] : [section[1]!]), section[2]!]
          : [];
        if (entry.uiLabels.join("\u0000") !== expected.join("\u0000"))
          throw new Error(
            `${context} path does not name settings section "${entry.entry.sectionId}" verbatim.`,
          );
      }
    }
    for (const related of feature.related)
      if (!idSet.has(related) || related === feature.id)
        throw new Error(`${context} has invalid related feature "${related}".`);
    for (const deferred of feature.deferredRelated ?? [])
      if (
        !feature.related.includes(deferred) ||
        manifest.features.find((item) => item.id === deferred)?.status !== "draft"
      )
        throw new Error(`${context} has invalid deferred related feature "${deferred}".`);
    if (feature.status === "published")
      for (const related of feature.related)
        if (
          manifest.features.find((item) => item.id === related)?.status !== "published" &&
          !feature.deferredRelated?.includes(related)
        )
          throw new Error(`${context} related feature "${related}" must publish or be deferred.`);
    for (const boundary of feature.boundaries) assertPlain(boundary, `${context} boundary`);
    if (!binding.sources.length) throw new Error(`${context} needs a source path.`);
    for (const file of [...binding.sources, ...binding.tests])
      await existingRelativeFile(rootDir, file, `${context} evidence`);
    const errors = new Map((binding.errors ?? []).map((item) => [item.id, item]));
    assertUnique(
      feature.troubleshooting.map((item) => item.errorId),
      `${context} error IDs`,
    );
    for (const item of feature.troubleshooting) {
      assertPlain(item.action, `${context} troubleshooting action`);
      assertPlain(item.message, `${context} troubleshooting message`);
      const error = errors.get(item.errorId);
      if (!error) throw new Error(`${context} error "${item.errorId}" lacks an evidence sentence.`);
      if (item.message !== error.text)
        throw new Error(`${context} error "${item.errorId}" differs from its cited sentence.`);
      assertPlain(error.text, `${context} error sentence`);
      const source = await existingRelativeFile(rootDir, error.source, `${context} error source`);
      if (labels.has(error.text) && error.source.startsWith("apps/web/") && !error.catalog)
        throw new Error(`${context} error "${item.errorId}" needs its English catalog binding.`);
      assertCitedErrorSentence(
        error.text,
        error.source,
        source,
        error.catalog,
        englishCatalog,
        `${context} error "${item.errorId}"`,
      );
    }
  }
  // Related links are directed recommendations; a cycle would make a tree loop forever.
  const byId = new Map(manifest.features.map((feature) => [feature.id, feature]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Related feature cycle includes "${id}".`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const related of byId.get(id)!.related) visit(related);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  for (const area of areas.keys()) {
    if (!manifest.features.some((feature) => feature.area === area && !feature.internal))
      throw new Error(`Area "${area}" has no public feature.`);
  }
  for (const shot of manifest.screenshots) {
    if (!usedScreenshots.has(shot.id)) throw new Error(`Screenshot "${shot.id}" is unused.`);
    if (shot.locale !== manifest.locale)
      throw new Error(
        `Screenshot "${shot.id}" locale "${shot.locale}" differs from manifest locale "${manifest.locale}".`,
      );
    assertPlain(shot.alt, `Screenshot "${shot.id}" alt`);
    if (shot.file !== `docs/${shot.id}.png`)
      throw new Error(`Screenshot "${shot.id}" has an invalid file name.`);
    if (shot.crop.x + shot.crop.width > shot.width || shot.crop.y + shot.crop.height > shot.height)
      throw new Error(`Screenshot "${shot.id}" crop is outside its dimensions.`);
    const bytes = await readCapture(`site/${shot.file}`, `Screenshot "${shot.id}"`);
    assertDocumentationPng(bytes, shot.width, shot.height, shot.file);
    const expectedHash = screenshotHashes.get(shot.id);
    if (!expectedHash || createHash("sha256").update(bytes).digest("hex") !== expectedHash)
      throw new Error(`Screenshot "${shot.id}" does not match its evidence SHA-256.`);
  }
  const publicBlock = publishedDocumentation(manifest);
  if (publicBlock) {
    const strings = (value: unknown): string[] => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value.flatMap(strings);
      if (value && typeof value === "object") return Object.values(value).flatMap(strings);
      return [];
    };
    const renderedText = strings(publicBlock);
    for (const value of [...renderedText, renderedText.join(" ")])
      assertPlain(value, "Published documentation");
  }
  return manifest;
}

export function assertFeatureDocsComplete(manifest: FeatureDocumentationManifest): void {
  const drafts = manifest.features.filter(
    (feature) => !feature.internal && feature.status !== "published",
  );
  if (drafts.length)
    throw new Error(`${drafts.length} verified user-facing documentation pages are still draft.`);
}

export function featureDocsReport(manifest: FeatureDocumentationManifest): string {
  const lines = ["Feature documentation coverage"];
  for (const area of [...new Set(manifest.features.map((feature) => feature.area))]) {
    const features = manifest.features.filter((feature) => feature.area === area);
    lines.push(
      `${area}: ${features.length} total, ${features.filter((f) => f.status === "draft").length} draft, ${features.filter((f) => f.internal).length} internal`,
    );
  }
  lines.push(
    `Total: ${manifest.features.length} features, ${manifest.features.filter((f) => f.status === "draft").length} draft, ${manifest.features.filter((f) => f.internal).length} internal`,
  );
  const verify = manifest.features.filter((feature) => feature.internal);
  lines.push(
    `Verify: ${verify.length} candidates — ${verify.map((feature) => feature.id).join(", ")}`,
  );
  return lines.join("\n");
}

export async function runFeatureDocs(rootDir = root): Promise<string> {
  return featureDocsReport(await loadValidatedFeatureDocs(rootDir));
}

export async function loadValidatedFeatureDocs(
  rootDir = root,
): Promise<FeatureDocumentationManifest> {
  const manifest = JSON.parse(await readFile(path.join(rootDir, manifestFile), "utf8")) as unknown;
  const parsed = FeatureDocumentationManifestSchema.parse(manifest);
  const missing = [];
  for (const shot of parsed.screenshots) {
    if (!(await stat(path.join(rootDir, "site", shot.file)).catch(() => null))?.isFile())
      missing.push(shot.file);
  }
  if (missing.length)
    throw new Error(
      `Documentation captures are missing: ${missing.join(", ")}. Run pnpm feature-docs:import-captures <dir> after capturing the pages.`,
    );
  const evidence = FeatureDocumentationEvidenceSchema.parse(
    JSON.parse(await readFile(path.join(rootDir, evidenceFile), "utf8")),
  );
  return validateFeatureDocs(parsed, evidence, rootDir);
}

export async function prepareFeatureDocCaptureImport(
  inputManifest: unknown,
  inputEvidence: unknown,
  directory: string,
) {
  const manifest = FeatureDocumentationManifestSchema.parse(inputManifest);
  const evidence = FeatureDocumentationEvidenceSchema.parse(inputEvidence);
  const shots = manifest.screenshots;
  const expected = new Set(shots.map((shot) => `${shot.id}.png`));
  const docsDir = path.join(directory, "docs");
  const entries = await readdir(docsDir, { withFileTypes: true });
  for (const entry of entries)
    if (!expected.has(entry.name) || !entry.isFile())
      throw new Error(`Unexpected documentation capture: ${entry.name}.`);
  const captures = new Map<string, Buffer>();
  for (const shot of shots) {
    const name = `${shot.id}.png`;
    if (!entries.some((entry) => entry.name === name))
      throw new Error(`Missing documentation capture: docs/${name}.`);
    if (shot.file !== `docs/${name}`) throw new Error(`Invalid manifest file for ${shot.id}.`);
    const bytes = await readFile(path.join(docsDir, name));
    assertDocumentationPng(bytes, shot.width, shot.height, shot.file);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    shot.width = width;
    shot.height = height;
    shot.crop = { x: 0, y: 0, width, height };
    captures.set(shot.id, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const existing = evidence.screenshots.find((item) => item.id === shot.id);
    if (existing) existing.sha256 = digest;
    else evidence.screenshots.push({ id: shot.id, sha256: digest });
  }
  return { manifest, evidence, captures };
}

async function writeIfChanged(file: string, bytes: Buffer | string): Promise<void> {
  const next = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if ((await readFile(file).catch(() => null))?.equals(next)) return;
  await writeFile(file, next);
}

export async function importFeatureDocCaptures(directory: string, rootDir = root): Promise<void> {
  const inputManifest = JSON.parse(await readFile(path.join(rootDir, manifestFile), "utf8"));
  const inputEvidence = JSON.parse(await readFile(path.join(rootDir, evidenceFile), "utf8"));
  const { manifest, evidence, captures } = await prepareFeatureDocCaptureImport(
    inputManifest,
    inputEvidence,
    directory,
  );
  await validateFeatureDocs(manifest, evidence, rootDir, (file, context) => {
    const id = path.basename(file, ".png");
    return captures.get(id) ?? existingRelativeBytes(rootDir, file, context);
  });
  await writeFeatureDocCaptureImport(rootDir, { manifest, evidence, captures });
}

export async function writeFeatureDocCaptureImport(
  rootDir: string,
  prepared: Awaited<ReturnType<typeof prepareFeatureDocCaptureImport>>,
): Promise<void> {
  const { manifest, evidence, captures } = prepared;
  await mkdir(path.join(rootDir, "site/docs"), { recursive: true });
  for (const [id, bytes] of captures)
    await writeIfChanged(path.join(rootDir, "site/docs", `${id}.png`), bytes);
  await writeIfChanged(path.join(rootDir, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeIfChanged(path.join(rootDir, evidenceFile), `${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const operation =
    command === "--import-captures"
      ? (async () => {
          if (!process.argv[3]) throw new Error("Usage: pnpm feature-docs:import-captures <dir>");
          await importFeatureDocCaptures(process.argv[3]);
          return loadValidatedFeatureDocs();
        })()
      : loadValidatedFeatureDocs();
  operation
    .then((manifest) => {
      console.log(featureDocsReport(manifest));
      if (process.argv.includes("--complete")) assertFeatureDocsComplete(manifest);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
