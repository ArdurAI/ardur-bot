import type { RunnerJobProvider } from "@ardurbot/adapter-kit";
import type { RunnerJobRequest } from "@ardurbot/contracts";
import { resolveSupervisorToken } from "@ardurbot/core";

export class DockerRunnerProvider implements RunnerJobProvider {
  constructor(private readonly supervisorUrl: string) {}

  private async fetchSupervisor(path: string, options: RequestInit = {}) {
    const token = resolveSupervisorToken();
    const headers = { ...options.headers, Authorization: `Bearer ${token}` };
    const res = await fetch(`${this.supervisorUrl}/runner-jobs${path}`, { ...options, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Supervisor error ${res.status}: ${text}`);
    }
    return res;
  }

  async probe(): Promise<boolean> {
    try {
      await this.fetchSupervisor("/probe");
      return true;
    } catch {
      return false;
    }
  }

  async start(request: RunnerJobRequest): Promise<{ providerRef: string }> {
    const res = await this.fetchSupervisor("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return res.json() as Promise<{ providerRef: string }>;
  }

  async inspect(providerRef: string): Promise<{ state: string }> {
    const res = await this.fetchSupervisor(`/${providerRef}/inspect`);
    return res.json() as Promise<{ state: string }>;
  }

  async *events(providerRef: string, sinceSeq: number) {
    const res = await this.fetchSupervisor(`/${providerRef}/events?sinceSeq=${sinceSeq}`);
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          yield JSON.parse(line.slice(6));
        }
      }
    }
  }

  async cancel(providerRef: string): Promise<void> {
    await this.fetchSupervisor(`/${providerRef}`, { method: "DELETE" });
  }

  async collect(
    providerRef: string,
  ): Promise<{ exitCode: number; artifacts: Array<{ path: string; sha256: string }> }> {
    const res = await this.fetchSupervisor(`/${providerRef}/collect`, { method: "POST" });
    return res.json() as Promise<{
      exitCode: number;
      artifacts: Array<{ path: string; sha256: string }>;
    }>;
  }

  async cleanup(providerRef: string): Promise<void> {
    await this.fetchSupervisor(`/${providerRef}/cleanup`, { method: "POST" });
  }
}
