import { resolveSupervisorToken } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock("dockerode", () => ({
  default: class {
    constructor(private readonly options: { socketPath?: string }) {
      created.push(options.socketPath);
    }
    async version() {
      await Promise.resolve();
      return {
        Components: [
          { Name: this.options.socketPath?.includes("podman") ? "Podman Engine" : "Engine" },
        ],
      };
    }
    async info() {
      return {
        SecurityOptions: this.options.socketPath?.includes("podman") ? ["name=rootless"] : [],
      };
    }
  },
}));

import { supervisorApp } from "./index.js";

describe("engine connection routing", () => {
  it("keeps simultaneous Docker and Podman requests on their selected sockets", async () => {
    const inspect = async (socket: string) => {
      const response = await supervisorApp.request("/computers/engine", {
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-ardurbot-engine-socket": socket,
        },
      });
      return response.json();
    };
    const [podman, docker] = await Promise.all([
      inspect("unix:///tmp/podman-route.sock"),
      inspect("/tmp/docker-route.sock"),
    ]);
    expect(podman).toMatchObject({
      name: "podman",
      rootless: true,
      capacity: { source: "docker" },
    });
    expect(docker).toMatchObject({
      name: "docker",
      rootless: false,
      capacity: { source: "docker" },
    });
    expect(created).toContain("/tmp/podman-route.sock");
  });

  it("authenticates before opening an engine connection", async () => {
    const before = created.length;
    const response = await supervisorApp.request("/computers/engine", {
      headers: { "x-ardurbot-engine-socket": "/tmp/unauthorized.sock" },
    });
    expect(response.status).toBe(401);
    expect(created.length).toBe(before);
  });
});
