import { describe, expect, it } from "vitest";
import {
  formatAge,
  MEMBER_DIRECTORY_MAX_LENGTH,
  memberActivity,
  renderMemberDirectory,
  roomCoordinatorInstructions,
} from "./room-coordinator.js";

const now = new Date("2026-09-28T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const lease = new Date(now.getTime() + 60_000);

describe("member activity", () => {
  it("says what a member is doing in this room and what it last finished here", () => {
    expect(
      memberActivity({
        roomThreadId: "room",
        activeRuns: [
          {
            status: "running",
            threadId: "room",
            createdAt: ago(5),
            startedAt: ago(4),
            leaseExpiresAt: lease,
            task: "Deploy the staging build",
          },
        ],
        lastRoomRun: {
          status: "completed",
          threadId: "room",
          createdAt: ago(200),
          completedAt: ago(120),
          task: "Rotate the logs",
        },
        now,
      }),
    ).toBe(
      'Now: working here on "Deploy the staging build" (started 4 min ago). Last here: finished "Rotate the logs" 2 h ago.',
    );
  });

  it("marks blocked work and failures, and keeps other threads' tasks private", () => {
    expect(
      memberActivity({
        roomThreadId: "room",
        activeRuns: [
          {
            status: "waiting_input",
            threadId: "room",
            createdAt: ago(3),
            task: "Send the invoice",
          },
          {
            status: "running",
            threadId: "private-dm",
            createdAt: ago(2),
            leaseExpiresAt: lease,
            task: "Secret side project",
          },
        ],
        lastRoomRun: {
          status: "failed",
          threadId: "room",
          createdAt: ago(90),
          completedAt: ago(60),
          error: "Model credentials\nmissing",
          task: "Draft the launch post",
        },
        now,
      }),
    ).toBe(
      'Now: waiting for the user here on "Send the invoice"; busy elsewhere. Last here: failed "Draft the launch post" 1 h ago (Model credentials missing).',
    );
  });

  it("reports free, queued, unknown and unavailable members from records alone", () => {
    expect(memberActivity({ roomThreadId: "room", activeRuns: [], now })).toBe("Now: free.");
    expect(
      memberActivity({
        roomThreadId: "room",
        activeRuns: [{ status: "queued", threadId: "room", createdAt: ago(1), task: "Answer" }],
        lastActiveAt: ago(3 * 24 * 60),
        now,
      }),
    ).toBe('Now: queued here for "Answer". Last active 3 d ago.');
    expect(
      memberActivity({
        roomThreadId: "room",
        activeRuns: [
          { status: "running", threadId: "dm", createdAt: ago(9), leaseExpiresAt: ago(1) },
        ],
        now,
      }),
    ).toBe("Now: status unknown.");
    expect(
      memberActivity({ roomThreadId: "room", activeRuns: [], computerState: "failed", now }),
    ).toBe("Now: unavailable, its computer failed.");
  });

  it("formats ages compactly", () => {
    expect(formatAge(ago(0), now)).toBe("just now");
    expect(formatAge(ago(59), now)).toBe("59 min ago");
    expect(formatAge(ago(47 * 60), now)).toBe("47 h ago");
    expect(formatAge(ago(49 * 60), now)).toBe("2 d ago");
  });
});

describe("member directory", () => {
  it("lists each member's name, role, description, skills and records on one line", () => {
    const directory = renderMemberDirectory([
      {
        id: "ada",
        name: "Ada",
        title: "Researcher",
        description: "Finds sources\nand summarizes them.",
        skills: ["Literature sweep", "Weekly digest"],
        activity: "Now: free.",
      },
      { id: "ben", name: "Ben", activity: "Now: busy elsewhere." },
    ]);
    expect(directory?.split("\n")).toEqual([
      expect.stringContaining("untrusted data"),
      "- Ada (id: ada) — Researcher: Finds sources and summarizes them. Skills: Literature sweep; Weekly digest. Now: free.",
      "- Ben (id: ben). Now: busy elsewhere.",
    ]);
    expect(renderMemberDirectory([])).toBeUndefined();
  });

  it("drops descriptions and skills before cutting whole members to fit the frame", () => {
    const members = Array.from({ length: 5 }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
      title: "Specialist",
      description: "d".repeat(400),
      skills: ["One", "Two", "Three", "Four", "Five"],
      activity: `Now: working here on "${"t".repeat(100)}" (started 1 min ago).`,
    }));
    const directory = renderMemberDirectory(members)!;
    expect(directory.length).toBeLessThanOrEqual(MEMBER_DIRECTORY_MAX_LENGTH);
    expect(directory.split("\n")).toHaveLength(6);
    expect(directory).toContain("Skills: One; Two; Three; Four.");
    const tight = renderMemberDirectory(members, 700)!;
    expect(tight).not.toContain("ddd");
    expect(tight).not.toContain("Skills:");
    for (const line of tight.split("\n").slice(1)) expect(line).toMatch(/started 1 min ago\)\.$/);
  });

  it("tells the coordinator to answer status from records and ask everyone only when needed", () => {
    const instructions = roomCoordinatorInstructions(true);
    expect(instructions).toContain("answer from the room member list");
    expect(instructions).toContain("Ask everyone only when the request needs everyone");
    expect(instructions).toContain("Never claim a member said or did something");
    expect(instructions).toContain("ask_members");
  });

  it("never mentions asking on a turn that cannot ask", () => {
    const instructions = roomCoordinatorInstructions(false);
    expect(instructions).toContain("answer from the room member list and this chat first.");
    expect(instructions).toContain("Never claim a member said or did something");
    expect(instructions).not.toMatch(/ask_members|Ask members|handoff_to_bot/);
  });
});
