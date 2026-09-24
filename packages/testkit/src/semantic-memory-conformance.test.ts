import {
  GraphitiMemoryProvider,
  Mem0MemoryProvider,
  SerenityMemoryProvider,
  SupermemoryMemoryProvider,
} from "@ardurbot/adapters";
import { vi } from "vitest";
import { semanticMemoryConformance } from "./semantic-memory-conformance.js";
import { semanticHttpFake } from "./semantic-memory-http-fake.js";

for (const kind of ["mem0", "mem0-oss", "graphiti", "supermemory", "serenity"] as const) {
  semanticMemoryConformance(kind, (now) => {
    const http = semanticHttpFake(kind);
    const network = {
      fetch: http.fetch,
      now,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    };
    const baseUrl = "http://127.0.0.1:8000";
    vi.stubGlobal("fetch", http.fetch);
    return {
      http,
      dispose: () => vi.unstubAllGlobals(),
      provider: () => {
        if (kind === "mem0" || kind === "mem0-oss")
          return new Mem0MemoryProvider(
            {
              transport: kind === "mem0" ? "platform-v3" : "oss-filters-v1",
              baseUrl: kind === "mem0" ? "https://api.mem0.ai" : baseUrl,
            },
            network,
          );
        if (kind === "graphiti") return new GraphitiMemoryProvider({ baseUrl }, network);
        if (kind === "supermemory")
          return new SupermemoryMemoryProvider({ baseUrl, apiKey: "fixture-placeholder" });
        return new SerenityMemoryProvider({
          endpoint: `${baseUrl}/mcp`,
          token: "fixture-placeholder",
          brainLabel: "",
          allowWrites: true,
        });
      },
    };
  });
}
