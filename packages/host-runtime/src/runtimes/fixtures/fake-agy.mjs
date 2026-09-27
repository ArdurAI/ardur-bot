import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.2.12\n");
  process.exit(0);
}
if (args[0] === "--help") {
  process.stdout.write("--print --model --effort --input-format --output-format --print-timeout\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(
    "Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n",
  );
  process.exit(0);
}
if (
  !args.includes("--print=") ||
  args[args.indexOf("--input-format") + 1] !== "stream-json" ||
  args[args.indexOf("--output-format") + 1] !== "stream-json"
) {
  process.stderr.write("invalid stream invocation\n");
  process.exit(1);
}
const input = readFileSync(0, "utf8");
let message;
try {
  const lines = input.trimEnd().split("\n");
  if (lines.length !== 1) throw new Error("expected exactly one user event");
  const event = JSON.parse(lines[0]);
  if (event.event !== "user" || !event.message)
    throw new Error('stream input "user" message is missing the "message" field');
  if (typeof event.message !== "object" || Array.isArray(event.message))
    throw new Error("could not decode stream input message");
  if (
    event.message.role !== "user" ||
    typeof event.message.content !== "string" ||
    !event.message.content
  )
    throw new Error('stream input "user" message has no content');
  message = event.message.content;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const prompt = message;
const fixture = prompt.includes("auth-error")
  ? "auth-error"
  : prompt.includes("denied-tool")
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
