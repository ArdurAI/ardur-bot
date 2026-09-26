import fs from "node:fs";

let code = fs.readFileSync("scripts/desktop-release.mjs", "utf8");

const replacement = `export async function generateWinget(version, assets, outputDir) {
  releaseVersion(\`v\${version}\`, version);
  await mkdir(outputDir, { recursive: true });
  const exe = await readFile(path.join(assets, \`ardur-bot-\${version}-win-x64.exe\`));
  const sha = createHash("sha256").update(exe).digest("hex");
  for (const file of ["ArdurAI.ArdurBot.installer.yaml", "ArdurAI.ArdurBot.locale.en-US.yaml", "ArdurAI.ArdurBot.yaml"]) {
    let template = await readFile(new URL(\`../packaging/winget/\${file}\`, import.meta.url), "utf8");
    template = template.replace(/@VERSION@/g, version);
    template = template.replace(/@X64_SHA256@/g, sha);
    await writeFile(path.join(outputDir, file), template);
  }
}`;

code = code.replace(/export async function generateWinget[\s\S]*?export async function generateCask/, replacement + "\n\nexport async function generateCask");

fs.writeFileSync("scripts/desktop-release.mjs", code);
