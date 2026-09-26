import { msg } from "@lingui/core/macro";

/** A pending board close that could not finish, shared by the Learning card and notifications. */
export const boardCloseFailedTitle = msg`A board item filed by a bot could not be closed.`;
export const boardCloseTriedBody = msg`Ardur Bot tried five times. Close it on the Board, or check that this computer is connected.`;
export const boardCloseDeniedBody = msg`The bot that filed this item can no longer use the board. Close it on the Board.`;
