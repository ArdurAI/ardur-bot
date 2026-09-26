import fs from "node:fs";

let code = fs.readFileSync("scripts/desktop-release.mjs", "utf8");

const replacement = `export async function generateCask(version, assets, output) {`;

const addition = `export async function generateWinget(version, assets, outputDir) {
  releaseVersion(\`v\${version}\`, version);
  let template = await readFile(new URL("../packaging/winget/ArdurAI.ArdurBot.installer.yaml", import.meta.url), "utf8");
  const exe = await readFile(path.join(assets, \`ardur-bot-\${version}-win-x64.exe\`));
  template = template.replace(/@VERSION@/g, version);
  template = template.replace(/@X64_SHA256@/g, createHash("sha256").update(exe).digest("hex"));
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "ArdurAI.ArdurBot.installer.yaml"), template);
}

export async function generateCask(version, assets, output) {`;

code = code.replace(replacement, addition);

fs.writeFileSync("scripts/desktop-release.mjs", code);
