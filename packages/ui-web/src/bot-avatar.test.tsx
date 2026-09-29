import { ACTIVE_RUN_STATUSES } from "@ardurbot/core";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AvatarStyleProvider } from "./avatar-style.js";
import {
  BotAvatar,
  DEFAULT_GROK_BOT_COLOR,
  GROK_BOT_COLORS,
  GrokShapePreview,
  parseBotAvatar,
  resolvePersonaColorDef,
  resolvePersonaShape,
} from "./bot-avatar.js";
import { SealScenePackProvider } from "./seal-scene.js";

describe("BotAvatar", () => {
  it("renders concurrent working avatars correctly", () => {
    const html = renderToString(
      <div>
        <BotAvatar color="#8B5CF6" status="running" />
        <BotAvatar color="#10B981" status="running" />
      </div>,
    );
    expect(html).toContain("<svg");
    expect(html).toContain("<circle");
  });

  it.each([...ACTIVE_RUN_STATUSES])(
    "renders appropriate visual states for active run statuses %s",
    (status) => {
      const html = renderToString(<BotAvatar color="#3B82F6" status={status} />);
      if (status === "running" || status === "queued" || status === "leased") {
        expect(html).toContain("<circle");
      } else if (status === "waiting_input") {
        expect(html).toContain('fill="var(--warning)"');
      } else if (status === "waiting_takeover") {
        expect(html).toContain('stroke-dasharray="8 6"');
      }
    },
  );

  it("draws only the disc and initial when idle", () => {
    const html = renderToString(<BotAvatar color="#F59E0B" status="idle" />);
    expect(html).not.toContain("<svg");
    expect(html).toContain('data-phase="idle"');
  });

  it("renders a seal by default for plain color values", () => {
    const html = renderToString(
      <BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="maya" size={28} status="running" />,
    );
    expect(html).toContain("M");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("<svg");
    expect(html).toContain("<circle");
    expect(html).not.toContain("<path");
  });

  it("renders distinct shapes for distinct bot identities", () => {
    const maya = renderToString(
      <BotAvatar color={DEFAULT_GROK_BOT_COLOR + "::shape_0"} identity="maya" />,
    );
    const github = renderToString(
      <BotAvatar color={DEFAULT_GROK_BOT_COLOR + "::shape_1"} identity="github" />,
    );
    expect(maya).not.toEqual(github);
  });

  it("parses shape indexes from encoded color values", () => {
    const parsed = parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_3`);
    expect(parsed.color).toBe(DEFAULT_GROK_BOT_COLOR);
    expect(parsed.shapeIndex).toBe(3);
    expect(parsed.isImage).toBe(false);
  });

  it("normalizes malformed shape suffixes to shape 0", () => {
    expect(parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_-1`).shapeIndex).toBe(0);
    expect(parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_3junk`).shapeIndex).toBe(0);
    expect(parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_`).shapeIndex).toBe(0);
  });

  it("exposes the violet identity color as the shared default", () => {
    expect(GROK_BOT_COLORS).toContain(DEFAULT_GROK_BOT_COLOR);
    expect(parseBotAvatar(`${DEFAULT_GROK_BOT_COLOR}::shape_0`).color).toBe(DEFAULT_GROK_BOT_COLOR);
  });

  it("resolves explicit colors and shapes", () => {
    expect(resolvePersonaColorDef("bot", "#10B981").hex.toLowerCase()).toBe("#2e6b6b");
    expect(resolvePersonaShape("bot", "hex")).toContain("M");
    expect(GROK_BOT_COLORS.length).toBeGreaterThan(0);
  });

  it("resolves a legacy custom hex to the nearest pigment without mutating the input", () => {
    const legacyHex = "#FF5733";
    const result = resolvePersonaColorDef("bot", legacyHex);
    expect(GROK_BOT_COLORS).toContain(result.hex);
    expect(legacyHex).toBe("#FF5733"); // Stored value untouched
    expect(resolvePersonaColorDef("bot", legacyHex).hex).toBe(result.hex); // Deterministic
  });

  it("falls back to the identity palette for invalid custom hex", () => {
    expect(resolvePersonaColorDef("bot", "#zzzzzz")).toEqual(resolvePersonaColorDef("bot"));
    expect(resolvePersonaColorDef("bot", "#ggg")).toEqual(resolvePersonaColorDef("bot"));
  });

  it("renders uploaded images without the geometric svg", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" size={32} />,
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("<path");
    expect(html).not.toContain("grok-character-eyes");
  });

  it("does not treat arbitrary http(s) color values as remote images", () => {
    const parsed = parseBotAvatar("https://evil.example/track.png");
    expect(parsed.isImage).toBe(false);
    expect(parsed.imageUrl).toBeUndefined();
    const html = renderToString(
      <BotAvatar color="https://evil.example/track.png" identity="maya" size={32} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
  });

  it("draws the phase's still pose and names its motion when motion is allowed", () => {
    const html = renderToString(
      <BotAvatar color="#8B5CF6" identity="maya" size={32} status="running" />,
    );
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-phase="thinking"');
    expect(html).toContain('opacity="0.65"');
    expect(html).toContain('class="ardurbot-seal-landscapes-wonders-thinking-ring"');
  });

  it("shows the scene from 40 px and the small-only layers below it", () => {
    const large = renderToString(<BotAvatar color="#2F4A7A" phase="waiting" size={40} />);
    expect(large).toContain("<line");
    expect(large).not.toContain("M8.43 74");
    const small = renderToString(<BotAvatar color="#2F4A7A" phase="waiting" size={24} />);
    expect(small).not.toContain("<line");
    expect(small).toContain("M8.43 74");
  });

  it("keeps the initial between the scene and the ring", () => {
    const html = renderToString(
      <BotAvatar color="#2F4A7A" label="Scout" phase="error" size={112} />,
    );
    const initial = html.indexOf(">S</span>");
    expect(html.indexOf("<svg")).toBeLessThan(initial);
    expect(html.lastIndexOf("<svg")).toBeGreaterThan(initial);
    expect(html).toContain("font-size:54px");
    expect(renderToString(<BotAvatar color="#2F4A7A" label="Scout" size={24} />)).toContain(
      "font-size:14px",
    );
  });

  it("prefers an explicit phase over the run status", () => {
    const html = renderToString(<BotAvatar color="#2F4A7A" phase="done" status="running" />);
    expect(html).toContain('data-phase="done"');
    expect(html).toContain('data-status="idle"');
  });

  it("switches the whole look with the chosen pack", () => {
    const html = renderToString(
      <SealScenePackProvider value="simple-ring">
        <BotAvatar color="#2F4A7A" identity="arc-test" size={40} status="running" />
      </SealScenePackProvider>,
    );
    expect(html).toContain('stroke-dasharray="198 66"');
    expect(html).toContain("ardurbot-seal-simple-ring-thinking-arc");
  });

  it("exposes shape picker name and pressed state", () => {
    const html = renderToString(
      <GrokShapePreview shapeIndex={0} color="#8B5CF6" selected onClick={() => undefined} />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("focus-visible:ring-2");
  });

  it("renders distinct robot and organic previews for the same identity", () => {
    const robot = renderToString(
      <BotAvatar
        color={DEFAULT_GROK_BOT_COLOR + "::shape_0"}
        identity="avatar-style-preview"
        variant="robot"
      />,
    );
    const organic = renderToString(
      <BotAvatar
        color={DEFAULT_GROK_BOT_COLOR}
        identity="avatar-style-preview"
        variant="organic"
      />,
    );
    expect(robot).not.toEqual(organic);
    expect(robot).toContain("grok-character-eyes");
    expect(organic).toContain("ardurbot-organic-avatar");
    expect(organic).not.toContain("grok-character-eyes");
  });

  it("uses the preferred avatar style when variant is omitted", () => {
    const html = renderToString(
      <AvatarStyleProvider value="organic">
        <BotAvatar color={DEFAULT_GROK_BOT_COLOR} identity="maya" />
      </AvatarStyleProvider>,
    );
    expect(html).toContain("ardurbot-organic-avatar");
    expect(html).not.toContain("grok-character-eyes");
  });

  it("keeps uploaded images when the organic style is preferred", () => {
    const html = renderToString(
      <BotAvatar color="data:image/png;base64,abc" identity="maya" variant="organic" />,
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("ardurbot-organic-avatar");
  });

  it("keeps an encoded studio shape when the organic style is preferred", () => {
    const html = renderToString(
      <BotAvatar color={`${DEFAULT_GROK_BOT_COLOR}::shape_3`} identity="maya" variant="organic" />,
    );
    expect(html).toContain("grok-character-eyes");
    expect(html).not.toContain("ardurbot-organic-avatar");
  });

  it("fills the organic body with the resolved palette hex when the custom color is invalid", () => {
    const fallback = resolvePersonaColorDef("maya", "#zzzzzz");
    const html = renderToString(<BotAvatar color="#zzzzzz" identity="maya" variant="organic" />);
    expect(html).toContain("ardurbot-organic-avatar");
    expect(html).toContain(`fill="${fallback.hex}"`);
    expect(html).not.toContain("#zzzzzz");
  });

  it.each([
    ["running", "running"],
    ["queued", "running"],
    ["leased", "running"],
    ["waiting_input", "waiting"],
    ["waiting_takeover", "paused"],
    ["idle", "idle"],
    [undefined, "idle"],
  ] as const)("exposes data-status=%s as %s", (raw, expected) => {
    const html = renderToString(
      <BotAvatar color="#9A3B1E" identity="test" status={raw as string} />,
    );
    expect(html).toContain(`data-status="${expected}"`);
  });

  it("applies the hand-cut seal edge at 28 px and above", () => {
    const large = renderToString(<BotAvatar color="#4E6B2F" identity="edge" size={40} />);
    expect(large).toContain("50% 48% 52% 50%");

    const small = renderToString(<BotAvatar color="#4E6B2F" identity="edge" size={20} />);
    expect(small).toContain("border-radius:50%");
  });
});
