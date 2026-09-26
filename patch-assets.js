const fs = require('fs');
let code = fs.readFileSync('scripts/desktop-release-assets.mjs', 'utf8');

// The original script loops over platforms, architectures, and extensions to read the files.
// We can compute the SHA-256 and write to checksums.txt.
const replacement = `
  }
  await writeFile(path.join(destination, file), yaml.dump(feed));
}
const crypto = await import("node:crypto");
let checksums = "";
const allFiles = (await readdir(destination)).filter(f => !f.endsWith(".yml") && !f.endsWith(".blockmap"));
for (const f of allFiles.sort()) {
  if (f === "checksums.txt" || f === "ardur-bot.rb") continue;
  const content = await readFile(path.join(destination, f));
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  checksums += \`\${hash}  \${f}\\n\`;
}
await writeFile(path.join(destination, "checksums.txt"), checksums);
await copyFile("scripts/install.sh", path.join(destination, "install.sh"));
await copyFile("packaging/winget/ArdurAI.ArdurBot.installer.yaml", path.join(destination, "ArdurAI.ArdurBot.installer.yaml"));
await generateCask(version, destination, path.join(destination, "ardur-bot.rb"));
`;

code = code.replace(/  \}\n  await writeFile\(path\.join\(destination, file\), yaml\.dump\(feed\)\);\n\}\nawait generateCask\(version, destination, path\.join\(destination, "ardur-bot\.rb"\)\);/, replacement);

fs.writeFileSync('scripts/desktop-release-assets.mjs', code);
