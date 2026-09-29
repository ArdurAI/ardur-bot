import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("Shell structure", () => {
  it("renders computerScreenError outside the screen-only content branch", () => {
    const code = readFileSync(join(__dirname, "Shell.tsx"), "utf8");
    // Ensure computerScreenError is placed above terminalSurface.tabs,
    // not hidden inside the else branch.
    expect(code).toMatch(
      /\{computerScreenError \? \(\s*<div[^>]*>\s*\{computerScreenError\}\s*<\/div>\s*\) : null\}\s*\{terminalSurface\.tabs\}/,
    );
    expect(code).not.toMatch(/!computerScreenError \? \(/);
  });

  it("counts a waiting bot from the lists once that chat is closed", () => {
    const code = readFileSync(join(__dirname, "Shell.tsx"), "utf8");
    const start = code.indexOf("const dockWaitingCount = useMemo");
    const end = code.indexOf("const activeReplyTarget", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const memo = code.slice(start, end);
    // Dashboard and Team leave `active` empty. A leftover snapshot must not stay in charge.
    expect(memo).toMatch(/openDockSnapshot\(\s*Boolean\(active\) \|\| inGroup/);
    expect(memo).toContain("snapshot: view.snapshot");
    expect(memo).toContain("viewingThreadId: view.viewingThreadId");
    expect(memo).not.toMatch(/snapshot:\s*snapshot/);
  });

  it("fetches the screen when its tab becomes visible", () => {
    const code = readFileSync(join(__dirname, "Shell.tsx"), "utf8");
    // Ensure there's an effect that depends on isVisible and calls refreshComputerScreen
    expect(code).toMatch(
      /useEffect\(\(\) => \{\n\s*if \(isVisible && !embeddedScreenUrl && computer\?\.state === "running"\) \{\n\s*const targetId = computerBot\?\.id \?\? active\?\.id;\n\s*if \(targetId\) void refreshComputerScreen\(targetId\);\n\s*\}\n\s*\}, \[isVisible/,
    );
  });
});
