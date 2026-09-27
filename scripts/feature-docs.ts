import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FeatureDocumentationEvidence,
  FeatureDocumentationManifest,
} from "../packages/contracts/src/feature-documentation";
import {
  FeatureDocumentationEvidenceSchema,
  FeatureDocumentationManifestSchema,
} from "../packages/contracts/src/feature-documentation";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = "site/data/feature-docs.json";
const evidenceFile = "site/data/feature-docs-evidence.json";
const settingsFile = "apps/web/src/pages/settings-sections.ts";
const webRoutesFile = "apps/web/src/App.tsx";
const mobileLayoutFile = "apps/mobile/app/_layout.tsx";
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedExemptions = {
  webRoutes: new Set(["/mcp/oauth/callback", "*"]),
  mobileEntries: new Set(["board", "connectors"]),
};
const nameDenylist =
  /\b(?:Claude|ChatGPT|OpenAI|Codex|Gemini|Anthropic|Ollama|Llama|DeepSeek|Copilot|Perplexity)\b/i;
const claimDenylist =
  /\b(?:best|fastest|seamless|effortless|ultimate|guaranteed|always|never|all your|powered by|created by|built by)\b/i;
const markup = /<[^>]+>|\[[^\]]*\]|[`*_#\r\n]|^\s*[-+]\s/m;

export type FeatureEvidence = FeatureDocumentationEvidence;

function assertPlain(value: string, context: string): void {
  if (markup.test(value) || nameDenylist.test(value) || claimDenylist.test(value)) {
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

async function existingRelativeFile(
  rootDir: string,
  file: string,
  context: string,
): Promise<string> {
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
  return readFile(absolute, "utf8");
}

/** Validate a draft authoring snapshot against the current checkout, without network or writes. */
export async function validateFeatureDocs(
  input: unknown,
  evidence: FeatureEvidence,
  rootDir = root,
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
  const labels = catalogLabels(
    await existingRelativeFile(rootDir, "apps/web/src/locales/en/messages.po", "English catalog"),
  );
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
  const usedScreenshots = new Set<string>();
  for (const feature of manifest.features) {
    const context = `Feature "${feature.id}"`;
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
    if (
      feature.status === "published" &&
      (feature.internal || !feature.steps.length || !feature.availableSince)
    )
      throw new Error(`${context} cannot publish without verified steps and availability.`);
    const orders = areas.get(feature.area) ?? new Set<number>();
    if (orders.has(feature.order))
      throw new Error(`${context} repeats order ${feature.order} in ${feature.area}.`);
    orders.add(feature.order);
    areas.set(feature.area, orders);
    for (const [name, value] of Object.entries({ title: feature.title, summary: feature.summary }))
      assertPlain(value, `${context} ${name}`);
    if (
      !feature.internal &&
      feature.id !== "self-host" &&
      !labels.has(feature.title) &&
      !(await nativeLabel(feature.title))
    )
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
      for (const label of step.uiLabels) {
        if (!labels.has(label) && !(await nativeLabel(label)))
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
      if (feature.platforms[platform as keyof typeof feature.platforms] === "unavailable")
        throw new Error(`${context} has a ${platform} path but marks it unavailable.`);
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
    for (const boundary of feature.boundaries) assertPlain(boundary, `${context} boundary`);
    if (!binding.sources.length) throw new Error(`${context} needs a source path.`);
    for (const file of [...binding.sources, ...binding.tests])
      await existingRelativeFile(rootDir, file, `${context} evidence`);
    const errors = new Map((binding.errors ?? []).map((item) => [item.id, item]));
    for (const item of feature.troubleshooting) {
      assertPlain(item.action, `${context} troubleshooting action`);
      const error = errors.get(item.errorId);
      if (!error) throw new Error(`${context} error "${item.errorId}" lacks an evidence sentence.`);
      assertPlain(error.text, `${context} error sentence`);
      const source = await existingRelativeFile(rootDir, error.source, `${context} error source`);
      if (!labels.has(error.text) && !source.includes(error.text))
        throw new Error(`${context} error "${item.errorId}" is not verbatim in its cited source.`);
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
    assertPlain(shot.alt, `Screenshot "${shot.id}" alt`);
    if (
      shot.crop &&
      (shot.crop.x + shot.crop.width > shot.width || shot.crop.y + shot.crop.height > shot.height)
    )
      throw new Error(`Screenshot "${shot.id}" crop is outside its dimensions.`);
    await existingRelativeFile(rootDir, shot.path, `Screenshot "${shot.id}"`);
  }
  return manifest;
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
  const manifest = JSON.parse(await readFile(path.join(rootDir, manifestFile), "utf8")) as unknown;
  const evidence = FeatureDocumentationEvidenceSchema.parse(
    JSON.parse(await readFile(path.join(rootDir, evidenceFile), "utf8")),
  );
  return featureDocsReport(await validateFeatureDocs(manifest, evidence, rootDir));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFeatureDocs()
    .then((report) => console.log(report))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
