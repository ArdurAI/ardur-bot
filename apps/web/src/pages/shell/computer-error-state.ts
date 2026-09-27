import { COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE } from "@ardurbot/contracts";

import type { ComputerScreenResult } from "../../lib/computer-screen";

interface OperationError {
  errorId: number;
  message: string;
  code?: string;
}

interface ScreenRequest {
  requestId: number;
  computerId: string;
}

interface PendingScreenRetry {
  errorId: number;
  computerId: string;
  requestIds: number[];
}

export interface ComputerErrorState {
  operation: OperationError | null;
  screen: string | null;
  lastErrorId: number;
  screenRequest: ScreenRequest | null;
  pendingRetry: PendingScreenRetry | null;
}

export const initialComputerErrorState: ComputerErrorState = {
  operation: null,
  screen: null,
  lastErrorId: 0,
  screenRequest: null,
  pendingRetry: null,
};

export type ComputerErrorAction =
  | { type: "boot-started" | "dismiss" }
  | { type: "operation-failed"; message: string; code?: string }
  | {
      type: "screen-requested";
      requestId: number;
      computerId: string;
      retryErrorId?: number;
    }
  | {
      type: "screen-result";
      requestId: number;
      computerId: string;
      result: ComputerScreenResult;
    }
  | { type: "screen-dismissed" };

/**
 * Transition                         Screen             Operation / retry
 * New request                        unchanged          start or carry retry for this computer
 * Current result                     result error       resolve only its recorded error
 * Superseded result                  unchanged          may still resolve its recorded error
 * New operation failure              unchanged          new error generation; cancel old retry
 */
export function reduceComputerError(
  state: ComputerErrorState,
  action: ComputerErrorAction,
): ComputerErrorState {
  switch (action.type) {
    case "boot-started":
    case "dismiss":
      return { ...initialComputerErrorState, lastErrorId: state.lastErrorId };
    case "operation-failed": {
      const errorId = state.lastErrorId + 1;
      return {
        ...state,
        lastErrorId: errorId,
        operation: { errorId, message: action.message, code: action.code },
        pendingRetry: null,
      };
    }
    case "screen-requested": {
      const pendingRetry =
        action.retryErrorId !== undefined &&
        state.operation?.errorId === action.retryErrorId &&
        state.operation.code !== COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE
          ? {
              errorId: action.retryErrorId,
              computerId: action.computerId,
              requestIds: [action.requestId],
            }
          : state.pendingRetry?.computerId === action.computerId
            ? {
                ...state.pendingRetry,
                requestIds: [...state.pendingRetry.requestIds, action.requestId],
              }
            : null;
      return {
        ...state,
        screenRequest: { requestId: action.requestId, computerId: action.computerId },
        pendingRetry,
      };
    }
    case "screen-result": {
      const current =
        state.screenRequest?.requestId === action.requestId &&
        state.screenRequest.computerId === action.computerId;
      const retry = state.pendingRetry;
      const partOfRetry =
        retry?.computerId === action.computerId && retry.requestIds.includes(action.requestId);
      const succeeded = Boolean(action.result.url) && !action.result.error;
      const resolvesOperation =
        partOfRetry &&
        succeeded &&
        state.operation?.errorId === retry.errorId &&
        state.operation.code !== COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE;
      const remainingRequests = partOfRetry
        ? retry.requestIds.filter((requestId) => requestId !== action.requestId)
        : [];
      return {
        ...state,
        operation: resolvesOperation ? null : state.operation,
        screen: current ? action.result.error : state.screen,
        pendingRetry:
          partOfRetry && !resolvesOperation && remainingRequests.length
            ? { ...retry, requestIds: remainingRequests }
            : partOfRetry
              ? null
              : retry,
      };
    }
    case "screen-dismissed":
      return { ...state, screen: null };
  }
}

export function visibleComputerError(
  state: ComputerErrorState,
  hasEmbeddedScreen: boolean,
): { message: string; code?: string } | null {
  if (state.operation) return state.operation;
  return state.screen && !hasEmbeddedScreen ? { message: state.screen } : null;
}
