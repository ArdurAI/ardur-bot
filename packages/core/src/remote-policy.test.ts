import { ALL_DEVICE_SCOPES } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  checkRemoteTool,
  classifyRemoteTool,
  effectiveRemoteAuthority,
  remotePermissionExpansion,
} from "./remote-policy.js";

const authority = {
  home: ALL_DEVICE_SCOPES,
  space: ALL_DEVICE_SCOPES,
  bot: ALL_DEVICE_SCOPES,
  user: ALL_DEVICE_SCOPES,
  device: ALL_DEVICE_SCOPES,
};
const now = 1_000_000;
describe("remote execution ceiling", () => {
  it.each(["board_ready", "board_show"])("allows %s with ordinary authority", (tool) => {
    expect(classifyRemoteTool(tool)).toBe("ordinary");
    expect(
      checkRemoteTool({
        tool,
        authority: { ...authority, device: ["dispatch", "ordinary"] },
        revoked: false,
        lastPresenceAt: null,
        now,
      }),
    ).toEqual({ allowed: true });
  });
  it.each([
    "board_create",
    "board_update",
    "board_claim",
    "board_close",
    "board_comment",
    "board_link",
  ])("keeps %s outside ordinary authority", (tool) => {
    expect(classifyRemoteTool(tool)).toBe("consequential");
    expect(
      checkRemoteTool({
        tool,
        authority: { ...authority, device: ["dispatch", "ordinary"] },
        revoked: false,
        lastPresenceAt: now,
        now,
      }).allowed,
    ).toBe(false);
  });
  it.each(["home", "space", "bot", "user", "device"] as const)(
    "intersects the %s policy even when every other policy allows",
    (layer) => {
      expect(effectiveRemoteAuthority({ ...authority, [layer]: ["read"] })).toEqual(["read"]);
      expect(
        checkRemoteTool({
          tool: "shell",
          authority: { ...authority, [layer]: ["dispatch", "ordinary"] },
          revoked: false,
          lastPresenceAt: now,
          now,
        }).allowed,
      ).toBe(false);
    },
  );
  it.each([
    "deploy",
    "github_deploy",
    "delete_resource",
    "iam_grant",
    "rotate_credential",
    "shell",
    "browser_act",
    "write_file",
    "unknown_tool",
    "connector_read_and_delete",
    "connector_get",
  ])("classifies %s on the server, without trusting a connector hint", (tool) => {
    expect(classifyRemoteTool(tool)).toBe("consequential");
  });
  it("allows a deploy only with scope and a fresh, non-future presence proof", () => {
    const input = { tool: "deploy", authority, revoked: false, now };
    expect(checkRemoteTool({ ...input, lastPresenceAt: now - 599_999 }).allowed).toBe(true);
    for (const lastPresenceAt of [null, now - 600_000, now + 1])
      expect(checkRemoteTool({ ...input, lastPresenceAt }).allowed).toBe(false);
    expect(checkRemoteTool({ ...input, lastPresenceAt: now, revoked: true }).allowed).toBe(false);
  });
  it.each([
    "always_allow",
    "pair_device",
    "set_tool_policy",
    "connect_agent",
    "request_secret",
    "schedule_create",
  ])("never permits %s from a device even with presence", (tool) => {
    expect(remotePermissionExpansion(tool)).toBe(true);
    expect(
      checkRemoteTool({ tool, authority, revoked: false, lastPresenceAt: now, now }).allowed,
    ).toBe(false);
  });
  it("requires a separate delegation grant", () => {
    expect(
      checkRemoteTool({
        tool: "message_bot",
        authority: { ...authority, device: ["dispatch", "ordinary"] },
        revoked: false,
        lastPresenceAt: now,
        now,
      }).allowed,
    ).toBe(false);
    expect(
      checkRemoteTool({ tool: "message_bot", authority, revoked: false, lastPresenceAt: null, now })
        .allowed,
    ).toBe(true);
  });
});

it.each(["add_mcp_server", "set_tool_policies", "cloud_agent_launch", "cloud_agent_reply"])(
  "does not let %s escape remote restrictions",
  (tool) => {
    expect(
      checkRemoteTool({ tool, authority, revoked: false, lastPresenceAt: now, now }).allowed,
    ).toBe(false);
  },
);
