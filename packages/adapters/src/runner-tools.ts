import type { ConnectorTool } from "@ardurbot/adapter-kit";

export const runnerTools: ConnectorTool[] = [
  {
    name: "list_runners",
    description: "List all runners explicitly shared with you by the owner.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "run_job",
    description: "Run a bounded job on a runner.",
    inputSchema: {
      type: "object",
      properties: {
        runner: { type: "string" },
        environment: { type: "string" },
        command: {
          type: "object",
          properties: {
            argv: { type: "array", items: { type: "string" } },
            cwd: { type: "string" }
          },
          required: ["argv"]
        }
      },
      required: ["runner", "environment", "command"]
    }
  },
  {
    name: "get_job",
    description: "Get the status and output of a runner job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"]
    }
  },
  {
    name: "cancel_job",
    description: "Cancel a running job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"]
    }
  }
];
