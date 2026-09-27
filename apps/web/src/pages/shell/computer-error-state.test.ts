import { COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE } from "@ardurbot/contracts";
import { expect, it } from "vitest";
import type { ComputerErrorAction } from "./computer-error-state";
import {
  initialComputerErrorState,
  reduceComputerError,
  visibleComputerError,
} from "./computer-error-state";

const success = { url: "/screen", error: null };
const noScreen = { url: null, error: null };
const screenFailure = { url: null, error: "Screen unavailable" };

const cases: Array<{
  name: string;
  actions: ComputerErrorAction[];
  operation: string | null;
  screen: string | null;
}> = [
  {
    name: "download failure survives a late empty screen result",
    actions: [
      { type: "screen-requested", requestId: 1, computerId: "computer" },
      {
        type: "operation-failed",
        message: "Download failed",
        code: COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE,
      },
      { type: "screen-result", requestId: 1, computerId: "computer", result: noScreen },
    ],
    operation: "Download failed",
    screen: null,
  },
  {
    name: "explicit retry clears the post-boot refresh failure it targeted",
    actions: [
      { type: "operation-failed", message: "Refresh failed" },
      { type: "screen-requested", requestId: 1, computerId: "computer", retryErrorId: 1 },
      { type: "screen-result", requestId: 1, computerId: "computer", result: success },
    ],
    operation: null,
    screen: null,
  },
  {
    name: "superseded explicit success still resolves its error",
    actions: [
      { type: "operation-failed", message: "Refresh failed" },
      { type: "screen-requested", requestId: 1, computerId: "computer", retryErrorId: 1 },
      { type: "screen-requested", requestId: 2, computerId: "computer" },
      { type: "screen-result", requestId: 1, computerId: "computer", result: success },
      { type: "screen-result", requestId: 2, computerId: "computer", result: success },
    ],
    operation: null,
    screen: null,
  },
  {
    name: "superseding background success carries the retry intent",
    actions: [
      { type: "operation-failed", message: "Refresh failed" },
      { type: "screen-requested", requestId: 1, computerId: "computer", retryErrorId: 1 },
      { type: "screen-requested", requestId: 2, computerId: "computer" },
      { type: "screen-result", requestId: 2, computerId: "computer", result: success },
      { type: "screen-result", requestId: 1, computerId: "computer", result: success },
    ],
    operation: null,
    screen: null,
  },
  {
    name: "failed explicit request can recover through the already pending refresh",
    actions: [
      { type: "operation-failed", message: "Refresh failed" },
      { type: "screen-requested", requestId: 1, computerId: "computer", retryErrorId: 1 },
      { type: "screen-requested", requestId: 2, computerId: "computer" },
      { type: "screen-result", requestId: 1, computerId: "computer", result: screenFailure },
      { type: "screen-result", requestId: 2, computerId: "computer", result: success },
    ],
    operation: null,
    screen: null,
  },
  {
    name: "newer Release failure survives an earlier retry success",
    actions: [
      { type: "operation-failed", message: "Refresh failed" },
      { type: "screen-requested", requestId: 1, computerId: "computer", retryErrorId: 1 },
      { type: "operation-failed", message: "Could not continue" },
      { type: "screen-result", requestId: 1, computerId: "computer", result: success },
    ],
    operation: "Could not continue",
    screen: null,
  },
  {
    name: "plain background success does not clear an operation error",
    actions: [
      { type: "operation-failed", message: "Refresh failed" },
      { type: "screen-requested", requestId: 1, computerId: "computer" },
      { type: "screen-result", requestId: 1, computerId: "computer", result: success },
    ],
    operation: "Refresh failed",
    screen: null,
  },
  {
    name: "a later background refresh cannot revive an exhausted retry",
    actions: [
      { type: "operation-failed", message: "Refresh failed" },
      { type: "screen-requested", requestId: 1, computerId: "computer", retryErrorId: 1 },
      { type: "screen-result", requestId: 1, computerId: "computer", result: screenFailure },
      { type: "screen-requested", requestId: 2, computerId: "computer" },
      { type: "screen-result", requestId: 2, computerId: "computer", result: success },
    ],
    operation: "Refresh failed",
    screen: null,
  },
  {
    name: "a late retry cannot clear a later download failure",
    actions: [
      { type: "operation-failed", message: "Refresh failed" },
      { type: "screen-requested", requestId: 1, computerId: "computer", retryErrorId: 1 },
      {
        type: "operation-failed",
        message: "Download failed",
        code: COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE,
      },
      { type: "screen-result", requestId: 1, computerId: "computer", result: success },
    ],
    operation: "Download failed",
    screen: null,
  },
];

it.each(cases)("$name", ({ actions, operation, screen }) => {
  const state = actions.reduce(reduceComputerError, initialComputerErrorState);
  expect(state.operation?.message ?? null).toBe(operation);
  expect(state.screen).toBe(screen);
  expect(visibleComputerError(state, Boolean(success.url))?.message ?? null).toBe(operation);
  expect(state.pendingRetry).toBeNull();
});

it("keeps operation generations monotonic across dismissals", () => {
  const first = reduceComputerError(initialComputerErrorState, {
    type: "operation-failed",
    message: "First failure",
  });
  const dismissed = reduceComputerError(first, { type: "dismiss" });
  const second = reduceComputerError(dismissed, {
    type: "operation-failed",
    message: "Second failure",
  });
  expect(second.operation?.errorId).toBe(2);
});

it("carries retry intent onto a superseding request before the explicit one returns", () => {
  const failed = reduceComputerError(initialComputerErrorState, {
    type: "operation-failed",
    message: "Refresh failed",
  });
  const retrying = reduceComputerError(failed, {
    type: "screen-requested",
    requestId: 1,
    computerId: "computer",
    retryErrorId: failed.operation?.errorId,
  });
  const superseded = reduceComputerError(retrying, {
    type: "screen-requested",
    requestId: 2,
    computerId: "computer",
  });
  expect(superseded.pendingRetry?.requestIds).toEqual([1, 2]);
  const recovered = reduceComputerError(superseded, {
    type: "screen-result",
    requestId: 2,
    computerId: "computer",
    result: success,
  });
  expect(recovered.operation).toBeNull();
  expect(recovered.pendingRetry).toBeNull();
});
