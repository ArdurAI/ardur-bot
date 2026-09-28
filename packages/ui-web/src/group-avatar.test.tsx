import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GroupAvatar } from "./group-avatar.js";

describe("GroupAvatar", () => {
  it("renders a placeholder for empty members", () => {
    const html = renderToString(<GroupAvatar members={[]} />);
    expect(html).toContain("svg");
    expect(html).not.toContain("ardurbot-bot-avatar");
  });

  it("renders a single bot avatar for 1 member", () => {
    const html = renderToString(
      <GroupAvatar members={[{ name: "A", color: "#F59E0B" }]} size={32} />,
    );
    expect(html).toContain("ardurbot-bot-avatar");
    expect(html).not.toContain("z-index");
  });

  it("renders 2 overlapping bot avatars for 2 members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "A", color: "#F59E0B" },
          { name: "B", color: "#3B82F6" },
        ]}
        size={40}
      />,
    );
    const count = (html.match(/ardurbot-bot-avatar/g) || []).length;
    expect(count).toBe(2);
  });

  it("renders a working member inside a group avatar", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "S", color: "#7A3F6A", status: "running" },
          { name: "E", color: "#2E6B6B" },
        ]}
      />,
    );
    expect(html).toContain("<circle"); // Running status has a ring
    expect(html).toContain("ardurbot-bot-avatar");
  });

  it("renders 3 overlapping bot avatars for 3 members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "A", color: "#F59E0B" },
          { name: "B", color: "#3B82F6" },
          { name: "C", color: "#10B981" },
        ]}
      />,
    );
    const count = (html.match(/ardurbot-bot-avatar/g) || []).length;
    expect(count).toBe(3);
  });

  it("renders a count badge for 4+ members", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "A", color: "#F59E0B" },
          { name: "B", color: "#3B82F6" },
          { name: "C", color: "#10B981" },
          { name: "D", color: "#8B5CF6" },
          { name: "E", color: "#EC4899" },
        ]}
      />,
    );
    expect(html).toContain("+3");
    // Should show 2 members plus the badge
    const count = (html.match(/ardurbot-bot-avatar/g) || []).length;
    expect(count).toBe(2);
  });

  it("uses box-shadow (not border) for seal separation so children do not paint over the ring", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "A", color: "#F59E0B" },
          { name: "B", color: "#3B82F6" },
        ]}
        size={40}
      />,
    );
    expect(html).toContain("box-shadow");
    expect(html).not.toContain("border:2px solid");
    expect(html).not.toContain("border-width:2px");
  });

  it("draws the separation ring with the seal's own edge so the gap stays even", () => {
    // The wrapper carrying the background box-shadow ring must use the same
    // radius as the seal inside it: the hand-cut ellipse at 28 px and above,
    // a true circle below.
    const ringRadius = (html: string) =>
      html.match(/border-radius:([^;]+);box-shadow:0 0 0 2px var\(--background\)/)?.[1];

    const large = renderToString(
      <GroupAvatar
        members={[
          { name: "A", color: "#F59E0B" },
          { name: "B", color: "#3B82F6" },
        ]}
        size={40}
      />,
    );
    expect(ringRadius(large)).toBe("50% 48% 52% 50% / 49% 51% 49% 51%");

    const small = renderToString(
      <GroupAvatar
        members={[
          { name: "A", color: "#F59E0B" },
          { name: "B", color: "#3B82F6" },
        ]}
        size={24}
      />,
    );
    expect(ringRadius(small)).toBe("50%");
  });

  it("exposes data-status on group member avatars", () => {
    const html = renderToString(
      <GroupAvatar
        members={[
          { name: "R", color: "#9A3B1E", status: "running" },
          { name: "I", color: "#2F4A7A" },
        ]}
      />,
    );
    expect(html).toContain('data-status="running"');
    expect(html).toContain('data-status="idle"');
  });
});
