import { RunnerJobRequest } from "@ardurbot/contracts";

export interface RunnerJobProvider {
  probe(): Promise<boolean>;
  start(request: RunnerJobRequest): Promise<{ providerRef: string }>;
  inspect(providerRef: string): Promise<{ state: string }>;
  events(providerRef: string, sinceSeq: number): AsyncIterable<{ seq: number, kind: string, stream?: string, payload: string }>;
  cancel(providerRef: string): Promise<void>;
  collect(providerRef: string): Promise<{ exitCode: number, artifacts: Array<{ path: string, sha256: string }> }>;
  cleanup(providerRef: string): Promise<void>;
}
