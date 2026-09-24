import type { AdapterContext, ComputerRef } from "./types.js";

/** Human control only. Terminal bytes never enter bot command recording. */
export interface TerminalContext extends AdapterContext {
  leaseId: string;
  fence: number;
  generation: string;
  expiresAt: number;
  workingRoot: string;
}
export interface TerminalSession {
  id: string;
  generation: string;
}
export interface TerminalOutput {
  seq: number;
  bytes: Uint8Array;
}
export interface TerminalProvider {
  open(
    computer: ComputerRef,
    options: { cols: number; rows: number; shellProfileId: string },
    context: TerminalContext,
  ): Promise<TerminalSession>;
  write(sessionId: string, bytes: Uint8Array): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  close(sessionId: string, reason: string): Promise<void>;
  output(sessionId: string): AsyncIterable<TerminalOutput>;
  /** Resolve only after input is fenced and all descendants have terminated. */
  revoke(computer: ComputerRef, leaseId: string, context: AdapterContext): Promise<void>;
}
