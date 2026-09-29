import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../components/bot-avatar.tsx", import.meta.url)),
  "utf8",
);

describe("mobile bot avatar", () => {
  it("never fills the running ring — react-native-svg defaults fill to black", () => {
    // Without fill="none" the ring's circle renders as a solid black disc
    // behind the seal on a running bot.
    const ring = source.match(/<AnimatedCircle[\s\S]*?\/>/);
    expect(ring).not.toBeNull();
    expect(ring![0]).toContain('fill="none"');
  });

  it("keeps the seal letter hidden from assistive tech", () => {
    // The bot name sits next to the avatar; the decorative initial must not be
    // read out on its own.
    const letter = source.match(/<Text[\s\S]*?\{initial\}/);
    expect(letter).not.toBeNull();
    expect(letter![0]).toContain("accessible={false}");
  });

  it("takes the initial from the first grapheme, not the first code unit", () => {
    expect(source).toContain("avatarInitial");
  });
});
