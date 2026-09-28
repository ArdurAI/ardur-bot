import { existsSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const entry = path.join(desktop, "dist", "main.js");
const seen = new Set();
const pending = [entry];

while (pending.length) {
  const file = pending.pop();
  if (!file || seen.has(file)) continue;
  seen.add(file);
  if (!existsSync(file) || !file.endsWith(".js")) {
    throw new Error(`Compiled main entry reaches a missing or non-JavaScript module: ${file}`);
  }
  const source = readFileSync(file, "utf8");
  const imports = [
    ...source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["']/g,
    ),
    ...source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ];
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
    const resolved = specifier.startsWith(".")
      ? path.resolve(path.dirname(file), specifier)
      : createRequire(file).resolve(specifier);
    if (!existsSync(resolved) || resolved.endsWith(".ts")) {
      throw new Error(`Compiled main entry cannot load ${specifier} from ${file}`);
    }
    if (specifier.startsWith(".") || realpathSync(resolved).startsWith(`${desktop}${path.sep}`)) {
      pending.push(resolved);
    }
  }
}
process.stdout.write(`Compiled main entry resolved ${seen.size} JavaScript modules.\n`);
