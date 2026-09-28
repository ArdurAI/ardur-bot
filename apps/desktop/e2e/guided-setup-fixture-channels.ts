import { GUIDED_SETUP_CHANNELS } from "@ardurbot/contracts/desktop-setup";

export const GUIDED_SETUP_FIXTURE_REQUEST_CHANNELS = Object.values(GUIDED_SETUP_CHANNELS).filter(
  (channel) => channel !== GUIDED_SETUP_CHANNELS.changed,
);
