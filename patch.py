import re

with open("scripts/desktop-release-assets.mjs", "r") as f:
    content = f.read()

replacement = """  }
  await writeFile(path.join(destination, file), yaml.dump(feed));
}
import crypto from "node:crypto";
let checksums = "";
const allFiles = (await readdir(destination)).filter(f => !f.endsWith(".yml") && !f.endsWith(".blockmap"));
for (const f of allFiles.sort()) {
  if (f === "checksums.txt" || f === "ardur-bot.rb") continue;
  const content = await readFile(path.join(destination, f));
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  checksums += `${hash}  ${f}\\n`;
}
await writeFile(path.join(destination, "checksums.txt"), checksums);
await copyFile("scripts/install.sh", path.join(destination, "install.sh"));
await copyFile("packaging/winget/ArdurAI.ArdurBot.installer.yaml", path.join(destination, "ArdurAI.ArdurBot.installer.yaml"));
await generateCask(version, destination, path.join(destination, "ardur-bot.rb"));
"""

pattern = r'  \}\n  await writeFile\(path\.join\(destination, file\), yaml\.dump\(feed\)\);\n\}\nawait generateCask\(version, destination, path\.join\(destination, "ardur-bot\.rb"\)\);'
content = re.sub(pattern, replacement, content)

with open("scripts/desktop-release-assets.mjs", "w") as f:
    f.write(content)
