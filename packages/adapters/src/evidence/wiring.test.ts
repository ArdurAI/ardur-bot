import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", "generated", "tests", "__tests__", "e2e"].includes(entry.name)
        ? []
        : sourceFiles(file);
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
  });
}

function recorderWiring(source: string): boolean[] {
  return Array.from(source.matchAll(/\bcreateRunExecutor\s*\(/g)).flatMap((call) => {
    if (/\bfunction\s*$/.test(source.slice(0, call.index))) return [];
    // Keep recording first at composition roots so this guard checks the argument,
    // not a nested property or an unrelated recorder elsewhere in the file.
    return [
      /^\s*\{\s*evidenceRecorder\s*:\s*createRunEvidenceRecorder\s*\(/.test(
        source.slice(call.index + call[0].length),
      ),
    ];
  });
}

describe("production evidence wiring", () => {
  it("injects the shared real recorder at every production executor call", () => {
    const files = ["apps", "packages"].flatMap((directory) =>
      sourceFiles(path.join(root, directory)),
    );
    const callers: string[] = [];
    for (const file of files) {
      for (const wired of recorderWiring(readFileSync(file, "utf8"))) {
        const relative = path.relative(root, file);
        callers.push(relative);
        expect(wired, `${relative}: missing shared evidence recorder as the first dependency`).toBe(
          true,
        );
      }
    }
    expect(callers).toEqual(
      expect.arrayContaining(["apps/api/src/app.ts", "apps/worker/src/index.ts"]),
    );
  });

  it("checks each call, rather than any recorder mention in the file", () => {
    expect(
      recorderWiring(`
        const evidenceRecorder = createRunEvidenceRecorder(deps);
        createRunExecutor({ prisma, nested: { evidenceRecorder } });
        createRunExecutor({ evidenceRecorder: createRunEvidenceRecorder(deps), prisma });
        createRunExecutor({ evidenceRecorder: createNoopEvidenceRecorder(), prisma });
      `),
    ).toEqual([false, true, false]);
  });

  it("ignores the executor definition and checks namespace calls", () => {
    expect(
      recorderWiring(`
        export function createRunExecutor(deps) {}
        adapters.createRunExecutor({ prisma });
      `),
    ).toEqual([false]);
  });
});
