import type { RuntimeAvailability } from "@ardurbot/contracts";
import { antigravityEffortForModel } from "@ardurbot/contracts";
import { captureChildOutput, childProcessLogger } from "../child-output.js";
import { nativeEnvironment } from "../host-environment.js";
import { environmentSecrets } from "../mcp-diagnostics.js";
import type { NativeSpawn } from "./native-process.js";
import { spawnNative, stopNative } from "./native-process.js";

type Models = RuntimeAvailability["models"];
const captured = `gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)
gemini-3.7-flash-low\tGemini 3.7 Flash (Low)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`;

export function parseAntigravityModels(output: string): Models {
  const rows = output
    .trimEnd()
    .split(/\r?\n/)
    .filter((line) => line !== "Fetching available models...");
  if (!rows.length || rows.length > 1024) throw new Error("Invalid model catalog.");
  const seen = new Set<string>();
  return rows.map((line) => {
    const fields = line.split("\t");
    if (
      fields.length !== 2 ||
      !/^[a-z0-9][a-z0-9.-]{0,159}$/.test(fields[0]!) ||
      !fields[1] ||
      Array.from(fields[1]!).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      seen.has(fields[0]!)
    )
      throw new Error("Invalid model catalog.");
    seen.add(fields[0]!);
    const effort = antigravityEffortForModel(fields[0]!);
    return {
      id: fields[0]!,
      label: fields[1]!,
      efforts: effort ? [effort] : [],
      effortMode: effort === null ? ("none" as const) : ("model-suffix" as const),
    };
  });
}

export const capturedAntigravityModels = parseAntigravityModels(captured);
export const antigravityCatalogCapturedAt = "2026-09-27";

const cache = new Map<string, { models: Models; checkedAt: string; expiresAt: number }>();
export async function antigravityModels(
  binary: string,
  version: string,
  start: NativeSpawn = spawnNative,
) {
  const key = `${binary}:${version}`;
  const previous = cache.get(key);
  if (previous && previous.expiresAt > Date.now())
    return {
      models: previous.models,
      catalogSource: "cache" as const,
      catalogCheckedAt: previous.checkedAt,
      catalogStale: false,
    };
  let child: ReturnType<NativeSpawn>;
  try {
    child = start(binary, ["models"]);
  } catch {
    return previous
      ? {
          models: previous.models,
          catalogSource: "cache" as const,
          catalogCheckedAt: previous.checkedAt,
          catalogStale: true,
        }
      : {
          models: capturedAntigravityModels,
          catalogSource: "captured" as const,
          catalogCheckedAt: antigravityCatalogCapturedAt,
          catalogStale: true,
        };
  }
  child.stdin.end();
  let output = "";
  let overflow = false;
  const startedAt = Date.now();
  let exitCode: number | null | undefined;
  const timer = setTimeout(() => void stopNative(child), 5_000);
  const captured = captureChildOutput(child, {
    kind: "antigravity-models",
    secrets: environmentSecrets(nativeEnvironment()),
    logger: childProcessLogger(),
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(output) + chunk.length > 128 * 1024) overflow = true;
    else output += chunk.toString("utf8");
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    exitCode = code;
    if (overflow || code !== 0) throw new Error("Model catalog unavailable.");
    const models = parseAntigravityModels(output);
    const checkedAt = new Date().toISOString();
    cache.set(key, { models, checkedAt, expiresAt: Date.now() + 15 * 60_000 });
    return {
      models,
      catalogSource: "live" as const,
      catalogCheckedAt: checkedAt,
      catalogStale: false,
    };
  } catch {
    // The catalog refresh degrades to the previous snapshot; the log carries why.
    const tail = captured.tail();
    childProcessLogger().error?.("Antigravity model catalog refresh failed", {
      ...captured.facts(),
      kind: "catalog unavailable",
      phase: "models",
      exitCode,
      durationMs: Date.now() - startedAt,
    });
    if (tail) childProcessLogger().debug(`Antigravity model catalog diagnostics: ${tail}`);
    return previous
      ? {
          models: previous.models,
          catalogSource: "cache" as const,
          catalogCheckedAt: previous.checkedAt,
          catalogStale: true,
        }
      : {
          models: capturedAntigravityModels,
          catalogSource: "captured" as const,
          catalogCheckedAt: antigravityCatalogCapturedAt,
          catalogStale: true,
        };
  } finally {
    clearTimeout(timer);
    captured.close();
    await stopNative(child);
  }
}
