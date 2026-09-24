import type { Routine } from "@ardurbot/contracts";
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
