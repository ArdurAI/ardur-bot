import { describe, expect, it } from "vitest";
import { AccountProfileInputSchema, AccountSettingsSchema } from "./account.js";

const profile = { name: "Account", displayName: "", workType: "", avatarStyle: "robot" };
const settings = {
  ...profile,
  spaceId: "space",
  instructions: "",
  instructionsRevision: 0,
  canEditInstructions: true,
  canManageDevices: false,
  requireTrustedDevices: false,
  desktopAvailable: false,
};

describe("account read compatibility", () => {
  it.each(["", "   ", "x".repeat(121)])(
    "reads a legacy name %j without weakening writes",
    (name) => {
      expect(AccountSettingsSchema.parse({ ...settings, name }).name).toBe(name);
      expect(AccountProfileInputSchema.safeParse({ ...profile, name }).success).toBe(false);
    },
  );
  it("preserves stored whitespace on read and trims new profile names", () => {
    expect(AccountSettingsSchema.parse({ ...settings, name: "  Account  " }).name).toBe(
      "  Account  ",
    );
    expect(AccountProfileInputSchema.parse({ ...profile, name: "  Account  " }).name).toBe(
      "Account",
    );
  });
});
