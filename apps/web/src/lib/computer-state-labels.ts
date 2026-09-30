import { COMPUTER_STATES } from "@ardurbot/contracts";
import { useLingui } from "@lingui/react/macro";

export function useComputerStateLabels() {
  const { t } = useLingui();
  return {
    [COMPUTER_STATES.stopped]: t`Stopped`,
    [COMPUTER_STATES.booting]: t`Starting`,
    [COMPUTER_STATES.running]: t`Running`,
    [COMPUTER_STATES.suspending]: t`Paused for an update`,
    [COMPUTER_STATES.suspended]: t`Sleeping`,
    [COMPUTER_STATES.error]: t`Could not start`,
  };
}
