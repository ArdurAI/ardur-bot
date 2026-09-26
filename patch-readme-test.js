import fs from "node:fs";

let code = fs.readFileSync("scripts/desktop-release.test.ts", "utf8");

const replacement = `
  it("does not require Docker in the README install section", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const installSectionMatch = readme.match(/## Install a desktop preview\\n([\\s\\S]*?)## Run from source/);
    expect(installSectionMatch).not.toBeNull();
    const installSection = installSectionMatch[1];
    expect(installSection.toLowerCase()).not.toContain("requires docker");
    expect(installSection.toLowerCase()).not.toContain("docker desktop");
  });
});`;

code = code.replace(/\}\);\n$/, replacement);
fs.writeFileSync("scripts/desktop-release.test.ts", code);
