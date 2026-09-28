import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Shell structure', () => {
  it('renders computerScreenError outside the screen-only content branch', () => {
    const code = readFileSync(join(__dirname, 'Shell.tsx'), 'utf8');
    // Ensure computerScreenError is placed above terminalSurface.tabs,
    // not hidden inside the else branch.
    expect(code).toMatch(/\{computerScreenError \? \(\s*<div[^>]*>\s*\{computerScreenError\}\s*<\/div>\s*\) : null\}\s*\{terminalSurface\.tabs\}/);
    expect(code).not.toMatch(/!computerScreenError \? \(/);
  });

  it('fetches the screen when its tab becomes visible', () => {
    const code = readFileSync(join(__dirname, 'Shell.tsx'), 'utf8');
    // Ensure there's an effect that depends on isVisible and calls refreshComputerScreen
    expect(code).toMatch(/useEffect\(\(\) => \{\n\s*if \(isVisible && !embeddedScreenUrl && computer\?\.state === "running"\) \{\n\s*const targetId = computerBot\?\.id \?\? active\?\.id;\n\s*if \(targetId\) void refreshComputerScreen\(targetId\);\n\s*\}\n\s*\}, \[isVisible/);
  });
});
