import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.2.12\n");
  process.exit(0);
}
if (args[0] === "--help") {
  process.stdout.write("--print --model --effort --output-format --print-timeout\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(
    "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
  );
  process.exit(0);
}
const prompt = args.find((arg) => arg.startsWith("--print=")) ?? "";
const fixture = prompt.includes("denied-tool")
  ? "denied-tool"
  : prompt.includes("model-error")
    ? "model-error"
    : "success";
const lines = readFileSync(new URL(`./${fixture}.ndjson`, import.meta.url), "utf8")
  .trimEnd()
  .split("\n");
if (prompt.includes("malformed")) lines.splice(1, 1, "{not-json}");
if (prompt.includes("premature")) lines.pop();
if (prompt.includes("mismatch"))
  lines[0] = lines[0].replace("gemini-3.8-flash-low", "gemini-3.8-flash-high");
for (const line of lines) {
  process.stdout.write(`${line}\n`);
  if (prompt.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 100));
}
process.exit(prompt.includes("nonzero") ? 1 : 0);
