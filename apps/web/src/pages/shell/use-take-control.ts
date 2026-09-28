import { useState } from "react";

export function useTakeControl(
  bootComputer: (args: { botId: string; takeControl: boolean; overlay: boolean }) => Promise<void>,
) {
  const [takingControl, setTakingControl] = useState(false);
  const takeControl = async (botId: string) => {
    setTakingControl(true);
    try {
      await bootComputer({ botId, takeControl: true, overlay: false });
    } catch (e) {
      // Error is expected to be dispatched by bootComputer
    } finally {
      setTakingControl(false);
    }
  };
  return { takingControl, takeControl };
}
