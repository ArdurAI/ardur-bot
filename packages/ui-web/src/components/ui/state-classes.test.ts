import { readFileSync } from "fs";
import { join } from "path";
import { expect, test } from "vitest";

test("state classes do not use bg-muted or bg-input for interaction states", () => {
  const components = ["button.tsx", "toggle.tsx", "tabs.tsx", "switch.tsx"];
  const badClasses = [
    "hover:bg-muted",
    "aria-pressed:bg-muted",
    "aria-expanded:bg-muted",
    "data-unchecked:bg-input",
  ];

  for (const component of components) {
    const file = readFileSync(join(__dirname, component), "utf-8");
    for (const badClass of badClasses) {
      expect(file, `${component} should not contain ${badClass}`).not.toContain(badClass);
    }
  }
});
