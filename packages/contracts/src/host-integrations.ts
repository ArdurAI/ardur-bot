import { z } from "zod";

export const HOST_INTEGRATIONS = {
  github: {
    command: "gh",
    args: ["auth", "status", "--active", "--json", "hosts"],
    installUrl: "https://cli.github.com/",
  },
  gitlab: {
    command: "glab",
    args: ["auth", "status"],
    installUrl: "https://docs.gitlab.com/cli/installation/",
  },
  aws: {
    command: "aws",
    args: ["sts", "get-caller-identity", "--output", "json"],
    installUrl: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
  },
  "google-cloud": {
    command: "gcloud",
    args: ["config", "list", "account", "--format=json"],
    installUrl: "https://cloud.google.com/sdk/docs/install",
  },
  azure: {
    command: "az",
    args: ["account", "show", "--output", "json"],
    installUrl: "https://learn.microsoft.com/cli/azure/install-azure-cli",
  },
  kubernetes: {
    command: "kubectl",
    args: ["config", "current-context"],
    installUrl: "https://kubernetes.io/docs/tasks/tools/",
  },
  jenkins: {
    command: "jenkins-cli",
    args: ["who-am-i"],
    installUrl: "https://www.jenkins.io/doc/book/managing/cli/",
  },
} as const;

export type HostIntegrationId = keyof typeof HOST_INTEGRATIONS;
export const HostIntegrationSchema = z.object({
  id: z.enum(["github", "gitlab", "aws", "google-cloud", "azure", "kubernetes", "jenkins"]),
  command: z.string(),
  state: z.enum(["signed-in", "not-found", "needs-sign-in", "unavailable"]),
  identity: z.string().max(240).nullable(),
  workspace: z.string().max(240).nullable(),
  checkedAt: z.iso.datetime(),
});
export type HostIntegration = z.infer<typeof HostIntegrationSchema>;

export function hostIntegration(id: string) {
  return Object.hasOwn(HOST_INTEGRATIONS, id)
    ? HOST_INTEGRATIONS[id as HostIntegrationId]
    : undefined;
}

export const HostIntegrationCommandSchema = z
  .object({
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((arg) =>
            [...arg].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
          ),
      )
      .min(1)
      .max(48),
  })
  .strict();

/** Credentials and executable overrides are never an integration tool's output or input. */
export function hostIntegrationCommand(id: string, input: unknown): string[] {
  const entry = hostIntegration(id);
  if (!entry) throw new Error("Unknown host integration.");
  const { args } = HostIntegrationCommandSchema.parse(input);
  const allowed: Record<string, readonly string[]> = {
    github: ["issue", "pr", "repo", "release", "run", "workflow", "project", "search", "label"],
    gitlab: ["issue", "mr", "repo", "release", "ci", "pipeline", "label"],
    aws: [
      "sts",
      "ec2",
      "ecs",
      "eks",
      "s3",
      "s3api",
      "cloudformation",
      "cloudwatch",
      "logs",
      "lambda",
      "rds",
      "dynamodb",
      "ecr",
    ],
    "google-cloud": [
      "compute",
      "container",
      "run",
      "projects",
      "logging",
      "monitoring",
      "storage",
      "sql",
      "functions",
    ],
    azure: [
      "group",
      "resource",
      "vm",
      "aks",
      "webapp",
      "functionapp",
      "monitor",
      "deployment",
      "network",
    ],
    kubernetes: [
      "get",
      "describe",
      "logs",
      "rollout",
      "scale",
      "patch",
      "apply",
      "delete",
      "label",
      "annotate",
      "wait",
      "top",
    ],
    jenkins: [
      "list-jobs",
      "build",
      "stop-builds",
      "cancel-quiet-down",
      "quiet-down",
      "enable-job",
      "disable-job",
      "delete-job",
      "set-build-description",
      "console",
      "who-am-i",
      "version",
    ],
  };
  if (!allowed[id]?.includes(args[0]!))
    throw new Error("This command is not available through integrations.");
  if (id === "aws" && args[0] === "sts" && (args[1] !== "get-caller-identity" || args.length !== 2))
    throw new Error("This command is not available through integrations.");
  const command = args.join(" ");
  if (
    /auth|credential|secret|token|password|private.key|config|exec|proxy|port-forward|--endpoint|--server|--host|--kubeconfig|--profile|--subscription|--account|--impersonate|--debug|--verbose|--log-http|--verbosity|--no-sign-request|--no-verify-ssl|--insecure|--raw|--request|--file|--cli-input|--generate-cli-skeleton|--json|--file|ssh|scp|--command|--parameters|--environment|--query|--format|--output|--jq|--template|(^|\s)-[sof](\s|=)|^api\b|groovy|script/i.test(
      command,
    )
  )
    throw new Error("This command is not available through integrations.");
  if (args.some((arg) => /^(?:file|https?):\/\//i.test(arg) || /^@/.test(arg)))
    throw new Error("File and URL arguments are unavailable through integrations.");
  // No shell or global CLI options. The executable is fixed by the catalog.
  if (!/^[a-z][a-z0-9-]*$/.test(args[0]!)) throw new Error("Choose a CLI command.");
  return [entry.command, ...args];
}
