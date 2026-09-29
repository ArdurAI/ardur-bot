import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveComputerImage } from "@ardurbot/contracts/computer-image";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  build?: unknown;
  command?: unknown;
  env_file?: unknown;
  /** YAML may parse unquoted scalars as null/number/boolean. */
  environment?: Record<string, unknown>;
  volumes?: string[];
  ports?: unknown[];
  user?: string;
  restart?: string;
  network_mode?: string;
  networks?: string[];
  profiles?: string[];
  extra_hosts?: string[];
}

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const composeFile = path.resolve(repoRoot, "infra/compose/docker-compose.images.yml");
const publishWorkflowFile = path.resolve(repoRoot, ".github/workflows/publish-server-image.yml");
const compose = parse(readFileSync(composeFile, "utf8")) as {
  services: Record<string, ComposeService>;
};
const appVersion = (
  JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;

it("lets packaged API and worker reach host model servers on every Docker platform", () => {
  for (const service of ["api", "worker"]) {
    expect(compose.services[service]?.extra_hosts).toContain("host.docker.internal:host-gateway");
    expect(compose.services[service]?.environment?.ARDURBOT_DEPLOYMENT_KIND).toBe("packaged");
  }
});
const publishWorkflow = parse(readFileSync(publishWorkflowFile, "utf8")) as {
  jobs?: {
    build?: {
      strategy?: {
        matrix?: {
          name?: unknown;
        };
      };
    };
    publish?: {
      strategy?: {
        matrix?: {
          name?: unknown;
        };
      };
    };
  };
};

const appServices = ["api", "worker", "web", "supervisor"] as const;
const FIRST_PARTY_IMAGE = /ghcr\.io\/ardurai\/ardur-bot\/([a-z0-9][a-z0-9._-]*)/g;

function firstPartyImageNames(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(FIRST_PARTY_IMAGE)].map((match) => match[1] ?? "");
}

function publishedNames(matrixName: unknown, ref: "dev" | "tag"): string[] {
  if (typeof matrixName !== "string") throw new Error("Publish matrix name must be an expression");
  const match = matrixName.match(
    /^\$\{\{\s*fromJSON\(github\.ref == 'refs\/heads\/dev' && '(\[[^']*\])' \|\| '(\[[^']*\])'\)\s*\}\}$/,
  );
  if (!match) throw new Error("Publish matrix must select dev and tag image names");
  const selected = ref === "dev" ? match[1] : match[2];
  if (!selected) throw new Error("Publish matrix must contain image names for both refs");
  const names: unknown = JSON.parse(selected);
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    !names.every((name) => typeof name === "string" && name.length > 0)
  ) {
    throw new Error("Publish matrix must contain image names");
  }
  return names;
}

function renderedComputerImage(env: Record<string, string>) {
  // Deployments run Compose beside a .env; some Compose releases check env_file entries during
  // config, so render from a scratch project directory that holds an empty one.
  const projectDir = mkdtempSync(path.join(tmpdir(), "ardurbot-compose-images-"));
  writeFileSync(path.join(projectDir, ".env"), "");
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-directory",
      projectDir,
      "--env-file",
      "/dev/null",
      "-f",
      composeFile,
      "--profile",
      "computer",
      "config",
      "--format",
      "json",
      "--no-env-resolution",
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        POSTGRES_PASSWORD: "placeholder",
        SANDBOX_SUPERVISOR_TOKEN: "placeholder",
        SCREEN_PROXY_SECRET: "placeholder",
        ...env,
      },
    },
  );
  rmSync(projectDir, { recursive: true, force: true });
  if (result.status !== 0) throw new Error(`Compose config failed: ${result.stderr}`);
  const rendered = JSON.parse(result.stdout) as {
    services: Record<string, { image?: string; environment?: Record<string, string> }>;
  };
  return rendered.services;
}

/**
 * The images compose file is the no-checkout happy path. It must stay pull-only and self-contained
 * so operators can drop it next to a .env outside any git worktree. Local Docker computers run via
 * an in-stack supervisor (app image + docker.sock) that stays unpublished on the host.
 */
describe("the images compose file", () => {
  it("ships the app version used by the standalone installer", () => {
    const template = readFileSync(path.join(repoRoot, "infra/compose/.env.images.example"), "utf8");
    expect(template.match(/^ARDURBOT_APP_VERSION=(.+)$/m)?.[1]).toBe(appVersion);
  });

  it("defines postgres, app roles, supervisor, and an inactive published computer image", () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      "api",
      "computer",
      "data-init",
      "postgres",
      "supervisor",
      "web",
      "worker",
    ]);
    for (const service of appServices) {
      expect(compose.services[service]?.image).toContain("ghcr.io/ardurai/ardur-bot/app");
      expect(compose.services[service]?.image).toContain("ARDURBOT_IMAGE_TAG");
    }
    expect(compose.services.computer?.image).toContain("ARDURBOT_COMPUTER_IMAGE_REF");
    expect(compose.services.computer?.image).toContain("ARDURBOT_COMPUTER_IMAGE_TAG");
    expect(compose.services.computer?.profiles).toEqual(["computer"]);
    expect(compose.services.postgres?.image).toMatch(
      /^\$\{POSTGRES_IMAGE:-postgres:16@sha256:[0-9a-f]{64}\}$/,
    );
    expect(compose.services["data-init"]?.image).toMatch(/^\$\{BUSYBOX_IMAGE:-busybox:1\}$/);
  });

  it.each([
    ["prerelease default", "0.1.0-alpha.1", {}, undefined],
    ["release default", "1.2.3", {}, undefined],
    [
      "image-only override",
      "0.1.0-alpha.1",
      { ARDURBOT_COMPUTER_IMAGE: "registry.example.com/computer:chosen" },
      "registry.example.com/computer:chosen",
    ],
    [
      "image and tag override",
      "0.1.0-alpha.1",
      {
        ARDURBOT_COMPUTER_IMAGE: "registry.example.com/mirror/ardurbot/computer",
        ARDURBOT_COMPUTER_IMAGE_TAG: "edge",
      },
      "registry.example.com/mirror/ardurbot/computer:edge",
    ],
    [
      "legacy untagged name",
      "1.2.3",
      { ARDURBOT_COMPUTER_IMAGE: "registry.example.com/computer" },
      "registry.example.com/computer",
    ],
  ] as const)(
    "renders the %s computer image selected by the supervisor",
    (_name, appVersion, env, override) => {
      const defaultRef = resolveComputerImage({ appVersion, localPresent: false });
      const services = renderedComputerImage(
        override ? env : { ARDURBOT_COMPUTER_IMAGE_REF: defaultRef, ...env },
      );
      expect(services.computer?.image).toBe(
        resolveComputerImage({ appVersion, localPresent: false, override }),
      );
      if (override) {
        expect(services.supervisor?.environment?.ARDURBOT_COMPUTER_IMAGE).toBe(override);
      } else {
        expect(services.supervisor?.environment?.ARDURBOT_COMPUTER_IMAGE).toBe("");
      }
    },
  );

  it("skips non-string Compose environment scalars when collecting image names", () => {
    expect(firstPartyImageNames(null)).toEqual([]);
    expect(firstPartyImageNames(true)).toEqual([]);
    expect(firstPartyImageNames(7091)).toEqual([]);
    expect(firstPartyImageNames("ghcr.io/ardurai/ardur-bot/computer:edge")).toEqual(["computer"]);
  });

  it("builds and publishes only the computer profiles on dev, and all images on tags", () => {
    for (const job of ["build", "publish"] as const) {
      const matrixName = publishWorkflow.jobs?.[job]?.strategy?.matrix?.name;
      expect(publishedNames(matrixName, "dev")).toEqual(["computer", "computer-developer"]);
      expect(publishedNames(matrixName, "tag").sort()).toEqual([
        "app",
        "computer",
        "computer-developer",
        "updater",
      ]);
    }
  });

  it("only references first-party images that the publish matrix publishes", () => {
    const published = new Set(
      publishedNames(publishWorkflow.jobs?.publish?.strategy?.matrix?.name, "tag"),
    );
    const referenced = new Set<string>();
    // The computer service's published default is supplied as a resolved ref by the launcher.
    if (compose.services.computer?.image?.includes("ARDURBOT_COMPUTER_IMAGE_REF")) {
      referenced.add("computer");
    }
    for (const service of Object.values(compose.services)) {
      for (const name of firstPartyImageNames(service.image)) {
        referenced.add(name);
      }
      for (const value of Object.values(service.environment ?? {})) {
        for (const name of firstPartyImageNames(value)) {
          referenced.add(name);
        }
      }
    }
    expect(published.size).toBeGreaterThan(0);
    expect(referenced.has("computer")).toBe(true);
    for (const name of referenced) {
      expect(
        published.has(name),
        `${name} referenced by images compose but omitted from publish matrix`,
      ).toBe(true);
    }
  });

  it("tells the api when the desktop app runs the stack, and nothing else does", () => {
    expect(compose.services.api?.environment?.ARDURBOT_DESKTOP_STACK).toBe(
      `\${ARDURBOT_DESKTOP_STACK:-}`,
    );
    expect(compose.services.worker?.environment).not.toHaveProperty("ARDURBOT_DESKTOP_STACK");
    expect(
      readFileSync(path.resolve(repoRoot, "infra/compose/.env.images.example"), "utf8"),
    ).not.toContain("ARDURBOT_DESKTOP_STACK");
  });

  it("passes optional HTTP(S)_PROXY / NO_PROXY into api and worker", () => {
    for (const name of ["api", "worker"] as const) {
      const env = compose.services[name]?.environment ?? {};
      expect(env.HTTP_PROXY).toBe("${HTTP_PROXY:-${http_proxy:-}}");
      expect(env.HTTPS_PROXY).toBe("${HTTPS_PROXY:-${https_proxy:-}}");
      expect(env.NO_PROXY).toBe("${NO_PROXY:-${no_proxy:-}}");
      expect(env.http_proxy).toBe("${http_proxy:-${HTTP_PROXY:-}}");
      expect(env.https_proxy).toBe("${https_proxy:-${HTTPS_PROXY:-}}");
      expect(env.no_proxy).toBe("${no_proxy:-${NO_PROXY:-}}");
    }
  });

  it("does not allocate a default network for offline init services", () => {
    for (const name of ["computer", "data-init"]) {
      expect(compose.services[name]?.network_mode).toBe("none");
      expect(compose.services[name]?.networks).toBeUndefined();
    }
    for (const name of ["postgres", ...appServices]) {
      expect(compose.services[name]?.networks?.length).toBeGreaterThan(0);
    }
  });

  it("never builds from a checkout", () => {
    for (const service of Object.values(compose.services)) {
      expect(service.build).toBeUndefined();
    }
  });

  it("loads secrets from a colocated .env", () => {
    expect(compose.services.api?.env_file).toEqual([".env"]);
    expect(compose.services.worker?.env_file).toEqual([".env"]);
  });

  it("defaults API and worker to Docker computers via the supervisor", () => {
    expect(compose.services.api?.environment?.SANDBOX_PROVIDER).toContain("docker");
    expect(compose.services.worker?.environment?.SANDBOX_PROVIDER).toContain("docker");
    expect(compose.services.api?.environment?.SANDBOX_SUPERVISOR_URL).toBe(
      "http://supervisor:7091",
    );
    expect(compose.services.worker?.environment?.SANDBOX_SUPERVISOR_URL).toBe(
      "http://supervisor:7091",
    );
  });

  it("keeps the Docker socket on the unpublished supervisor only", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      const hasSocket = (service.volumes ?? []).some((volume) => volume.includes("docker.sock"));
      if (name === "supervisor") {
        expect(hasSocket).toBe(true);
        expect(service.ports).toBeUndefined();
        expect(service.user).toBe("root");
        expect(String(service.command)).toContain("sandbox-supervisor");
      } else {
        expect(hasSocket).toBe(false);
      }
    }
  });

  it("publishes the web UI on loopback only", () => {
    expect(compose.services.web?.ports).toEqual(["127.0.0.1:${ARDURBOT_WEB_PORT:-5173}:5173"]);
    expect(compose.services.api?.ports).toEqual(["127.0.0.1:${ARDURBOT_API_PORT:-3100}:3100"]);
    for (const key of ["BETTER_AUTH_URL", "WEB_ORIGIN", "API_URL"]) {
      expect(compose.services.api?.environment?.[key]).toBe(`\${${key}:-http://127.0.0.1:5173}`);
    }
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.supervisor?.ports).toBeUndefined();
  });

  it("passes logging variables to the supervisor without putting them on computer containers", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(compose.services.supervisor?.environment?.AXIOM_TOKEN).toBe("${AXIOM_TOKEN:-}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal Compose expression
    expect(compose.services.supervisor?.environment?.AXIOM_DATASET).toBe("${AXIOM_DATASET:-}");
    expect(compose.services.computer?.environment?.AXIOM_TOKEN).toBeUndefined();
    expect(compose.services.computer?.environment?.LOG_LEVEL).toBeUndefined();
  });
});
