import { COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE } from "@ardurbot/contracts";

import type { ComputerScreenResult } from "../../lib/computer-screen";

export interface ComputerErrorState {
  operation: { message: string; code?: string } | null;
  screen: string | null;
}

export const initialComputerErrorState: ComputerErrorState = {
  operation: null,
  screen: null,
};

type ComputerErrorAction =
  | { type: "boot-started" | "dismiss" }
  | { type: "operation-failed"; message: string; code?: string }
  | { type: "screen-result"; error: string | null }
  | { type: "screen-retry-succeeded" }
  | { type: "screen-dismissed" };

export function computerScreenResultAction(
  result: ComputerScreenResult,
  explicitRetry: boolean,
): ComputerErrorAction {
  return explicitRetry && result.url && !result.error
    ? { type: "screen-retry-succeeded" }
    : { type: "screen-result", error: result.error };
}

export function reduceComputerError(
  state: ComputerErrorState,
  action: ComputerErrorAction,
): ComputerErrorState {
  switch (action.type) {
    case "boot-started":
    case "dismiss":
      return initialComputerErrorState;
    case "operation-failed":
      return { ...state, operation: { message: action.message, code: action.code } };
    case "screen-result":
      return { ...state, screen: action.error };
    case "screen-retry-succeeded":
      return {
        operation:
          state.operation?.code === COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE ? state.operation : null,
        screen: null,
      };
    case "screen-dismissed":
      return { ...state, screen: null };
  }
}

export function visibleComputerError(state: ComputerErrorState, hasEmbeddedScreen: boolean) {
  if (state.operation) return state.operation;
  return state.screen && !hasEmbeddedScreen ? { message: state.screen } : null;
}
