import type {
  SemanticMemoryProvider,
  SemanticMemoryResponse,
  SemanticMemoryResult,
} from "@ardurbot/adapter-kit";

/** Preserve the selected destination when its credentials/configuration cannot be used. */
export class UnavailableMemoryProvider implements SemanticMemoryProvider {
  constructor(private readonly id: string) {}
  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { recall: true, save: true, purgeHistory: true, sharedScope: true } as const,
    };
  }
  async recall(): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    return {
      ok: false,
      error: "The selected memory service is unavailable. Reconnect it in Settings.",
    };
  }
  async save(): Promise<SemanticMemoryResponse> {
    return {
      ok: false,
      error: "The selected memory service is unavailable. Reconnect it in Settings.",
    };
  }
  async purgeHistory(): Promise<SemanticMemoryResponse> {
    return {
      ok: false,
      error: "The selected memory service is unavailable. Reconnect it in Settings.",
    };
  }
  async deleteDocument(): Promise<SemanticMemoryResponse> {
    return {
      ok: false,
      error: "The selected memory service is unavailable. Reconnect it in Settings.",
    };
  }
}
