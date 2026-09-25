import type { AccountSession, AccountSettings, LocalDevice } from "@ardurbot/contracts";

export const accountFixture: AccountSettings = {
  name: "Test operator",
  displayName: "Captain",
  workType: "research",
  avatarStyle: "robot",
  spaceId: "test-space",
  instructions: "Use concise answers.",
  instructionsRevision: 1,
  canEditInstructions: true,
  canManageDevices: true,
  requireTrustedDevices: false,
  desktopAvailable: true,
};
export const localDevicesFixture: LocalDevice[] = [
  {
    id: "default",
    kind: "host",
    name: "Test computer",
    platform: "linux",
    registrationId: "host-generation",
    createdAt: "2026-09-24T05:00:00.000Z",
    lastSeenAt: "2026-09-24T06:00:00.000Z",
    approved: true,
  },
  {
    id: "phone",
    kind: "device",
    name: "Test phone",
    platform: "ios",
    createdAt: "2026-09-24T05:00:00.000Z",
    lastSeenAt: null,
    approved: false,
  },
];
export const sessionsFixture: AccountSession[] = Array.from({ length: 14 }, (_, i) => ({
  id: `session-${i}`,
  device: i === 0 ? "Desktop app" : `Firefox · Linux ${i}`,
  current: i === 0,
  createdAt: "2026-09-24T05:00:00.000Z",
  updatedAt: "2026-09-24T06:00:00.000Z",
}));
