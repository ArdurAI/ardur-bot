import type { Routine } from "@ardurbot/contracts";
import { Trans } from "@lingui/react/macro";
import { RoutineListHeader, RoutineListRow } from "../../pages/RoutineEditor";

export default function RoutinesPanel({
  routines,
  onCreate,
  onOpen,
  onStop,
  runningId,
}: {
  routines: readonly Routine[];
  onCreate: () => void;
  onOpen: (routine: Routine) => void;
  onStop: () => void;
  runningId?: string;
}) {
  return (
    <>
      <RoutineListHeader onCreate={onCreate} />
      {routines.length === 0 ? (
        <p className="px-2.5 text-sm text-muted-foreground">
          <Trans>
            No routines yet; a routine runs this bot on a schedule or when an event arrives.
          </Trans>
        </p>
      ) : null}
      {routines.map((routine) => (
        <RoutineListRow
          key={routine.id}
          routine={routine}
          running={routine.id === runningId}
          onOpen={() => onOpen(routine)}
          onStop={onStop}
        />
      ))}
    </>
  );
}
